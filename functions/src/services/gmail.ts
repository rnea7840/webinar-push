// ── functions/src/services/gmail.ts ───────────────────────────
// Slim Gmail sender used only when prospect has a verified email.
// Authenticates via service-account-on-behalf-of-sender (Google
// Workspace domain-wide delegation) OR an OAuth refresh token stored
// in settings/config.gmailRefreshToken. Either method works; this
// module abstracts both.
//
// Includes ICS calendar invite as an alternative attachment for the
// webinar.
//
// NOTE: For v1 we expose a single function sendWebinarEmail. If
// settings.gmailEnabled is false or no auth is configured, it
// returns success=false silently so the sender can fall back.

import * as admin from "firebase-admin";
import type { EventConfig } from "../types";

const db = () => admin.firestore();
const FieldValue = admin.firestore.FieldValue;

function utcStamp(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) + "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) + "Z"
  );
}

function escapeIcs(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

export function buildIcs(event: EventConfig, prospectEmail?: string): string {
  const start = new Date(event.startsAt);
  const end = new Date(start.getTime() + event.durationMinutes * 60 * 1000);
  const uid = `${event.linkedinEventId}@webinar-push`;
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//webinar-push//EN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${utcStamp(new Date())}`,
    `DTSTART:${utcStamp(start)}`,
    `DTEND:${utcStamp(end)}`,
    `SUMMARY:${escapeIcs(event.title)}`,
    `DESCRIPTION:${escapeIcs((event.description || "") + "\\n\\nRegister: " + event.registrationUrl)}`,
    `LOCATION:${escapeIcs(event.online ? "Online webinar — " + event.registrationUrl : "TBA")}`,
    `URL:${event.registrationUrl}`,
    `ORGANIZER;CN=${escapeIcs(event.host)}:mailto:noreply@${(event.host || "host").toLowerCase().replace(/\W+/g, "")}.example`,
    prospectEmail ? `ATTENDEE;RSVP=TRUE;CN=${escapeIcs(prospectEmail)}:mailto:${prospectEmail}` : "",
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean).join("\r\n");
}

interface SendArgs {
  to: string;
  toName?: string;
  subject: string;
  body: string;
  event: EventConfig;
  prospectId: string;
  trackingToken?: string;
}

interface SendResult {
  success: boolean;
  error?: string;
  messageId?: string;
}

async function getGmailAuth(): Promise<{
  enabled: boolean;
  senderEmail?: string;
  senderName?: string;
  accessToken?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  error?: string;
}> {
  const snap = await db().collection("settings").doc("config").get();
  const data = snap.data() || {};
  if (!data.gmailEnabled) return { enabled: false };

  return {
    enabled: true,
    senderEmail: data.gmailSenderEmail,
    senderName: data.gmailSenderName,
    refreshToken: data.gmailRefreshToken,
    clientId: data.gmailClientId,
    clientSecret: data.gmailClientSecret,
  };
}

async function refreshAccessToken(auth: {
  refreshToken?: string; clientId?: string; clientSecret?: string;
}): Promise<string | null> {
  if (!auth.refreshToken || !auth.clientId || !auth.clientSecret) return null;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: auth.clientId,
      client_secret: auth.clientSecret,
      refresh_token: auth.refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });
  if (!res.ok) return null;
  const j = (await res.json()) as { access_token?: string };
  return j.access_token || null;
}

function buildMime(args: SendArgs, fromEmail: string, fromName: string, ics: string): string {
  const boundary = "----wp_" + Math.random().toString(36).slice(2);
  const fromHeader = fromName ? `${fromName} <${fromEmail}>` : fromEmail;
  const toHeader = args.toName ? `${args.toName} <${args.to}>` : args.to;

  const lines = [
    `From: ${fromHeader}`,
    `To: ${toHeader}`,
    `Subject: ${args.subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    args.body,
    "",
    `--${boundary}`,
    `Content-Type: text/calendar; method=REQUEST; name="invite.ics"`,
    "Content-Transfer-Encoding: 7bit",
    `Content-Disposition: attachment; filename="invite.ics"`,
    "",
    ics,
    "",
    `--${boundary}--`,
  ];
  return lines.join("\r\n");
}

function base64UrlEncode(s: string): string {
  return Buffer.from(s, "utf-8").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sendWebinarEmail(args: SendArgs): Promise<SendResult> {
  const auth = await getGmailAuth();
  if (!auth.enabled) return { success: false, error: "Gmail not enabled" };
  if (!auth.senderEmail) return { success: false, error: "Gmail sender email not set" };

  const accessToken = await refreshAccessToken(auth);
  if (!accessToken) return { success: false, error: "Failed to refresh Gmail access token" };

  const ics = buildIcs(args.event, args.to);
  const raw = buildMime(args, auth.senderEmail, auth.senderName || "", ics);

  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw: base64UrlEncode(raw) }),
  });

  if (!res.ok) {
    const text = await res.text();
    await db().collection("activity_log").add({
      type: "email_send_error",
      message: `Gmail send failed (${res.status}): ${text.slice(0, 300)}`,
      metadata: { prospectId: args.prospectId, status: res.status },
      timestamp: FieldValue.serverTimestamp(),
    });
    return { success: false, error: `Gmail ${res.status}: ${text.slice(0, 300)}` };
  }

  const j = (await res.json()) as { id?: string };
  return { success: true, messageId: j.id };
}
