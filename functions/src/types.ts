// ── functions/src/types.ts ────────────────────────────────────
// Shared types for the webinar push bot.

export type Channel = "linkedin_dm" | "linkedin_connect" | "linkedin_inmail" | "email";

export type ProspectStatus =
  | "sourced"        // pulled from search, not yet enriched
  | "qualified"      // passed ICP filter
  | "drafted"        // outreach copy generated
  | "queued"         // approved (auto or manual) and ready to send
  | "sent"           // first touch sent
  | "follow_up_1"    // T-3 nudge sent
  | "follow_up_2"    // T-1 reminder sent
  | "follow_up_3"    // T-0 day-of nudge sent
  | "replied"        // they responded
  | "registered"     // confirmed registration (via tracker)
  | "rejected"       // failed quality bar or manual reject
  | "errored";       // send failed terminally

export interface EventConfig {
  linkedinEventId: string;        // "7455003189491183616"
  linkedinEventUrl: string;       // https://www.linkedin.com/events/7455003189491183616/
  registrationUrl: string;        // carahevents URL
  title: string;                  // "SBOM Analysis and Protocol Fuzzing..."
  host: string;                   // "Apona Security"
  channel: string;                // "Carahsoft"
  description?: string;           // optional blurb pulled into copy
  speakers?: string[];
  startsAt: string;               // ISO: 2026-05-12T14:00:00Z (10am ET)
  durationMinutes: number;
  online: boolean;
}

export interface IcpFilter {
  jobTitles: string[];
  industries?: string[];
  companies?: string[];
  excludeCompanies?: string[];
  locations?: string[];
  followerOf?: string[];          // company URLs/IDs to pull followers from
  connectionDegree?: ("1st" | "2nd" | "3rd+")[];
  premiumOnly?: boolean;
  minQualityScore?: number;       // 0-10, default 7
}

export interface LinkedInAccount {
  id: string;
  enabled: boolean;
  connectSafelyAccountId?: string; // if multi-account on the CS side
  label?: string;                  // e.g. "Founder seat"
}

export interface SettingsDoc {
  // Auth
  connectSafelyApiKey?: string;
  anthropicApiKey?: string;
  anthropicModel?: string;          // default "claude-sonnet-4-6"

  // Senders
  linkedinAccounts?: LinkedInAccount[];
  gmailEnabled?: boolean;
  gmailSenderEmail?: string;
  gmailSenderName?: string;

  // Event
  event?: EventConfig;

  // Targeting
  icp?: IcpFilter;

  // Limits
  linkedinDailyLimit?: number;                   // base DM limit per account/day (default 25)
  linkedinInmailDailyLimitPerAccount?: number;   // default 5
  linkedinConnectWeeklyLimit?: number;           // default 90
  linkedinWarmupStartDate?: any;                 // Firestore Timestamp; null = no ramp

  // Operational
  paused?: boolean;
  linkedinPaused?: boolean;
  linkedinPauseReason?: string;
  linkedinPausedAt?: any;
  autoSendQualityFloor?: number;                 // 0-10, default 7
  mode?: "sandbox" | "live";                     // sandbox = dry-run, live = actually send
}

export interface ProspectDoc {
  id: string;
  // Identity
  fullName?: string;
  firstName?: string;
  lastName?: string;
  headline?: string;
  jobTitle?: string;
  company?: string;
  companyId?: string;
  industry?: string;
  location?: string;
  profileUrl: string;              // linkedin.com/in/...
  email?: string;
  emailSource?: "apollo" | "icypeas" | "manual" | "linkedin";

  // Targeting metadata
  source: "search" | "company_followers" | "csv";
  followerOfCompanyId?: string;
  connectionDegree?: "1st" | "2nd" | "3rd+";
  isPremium?: boolean;

  // Pipeline state
  status: ProspectStatus;
  qualityScore?: number;           // 0-10 from anthropic
  qualityReasoning?: string;

  // Routing
  channel?: Channel;
  linkedinAccountId?: string;      // which sender to use

  // Generated copy (drafts)
  connectNote?: string;            // ≤300 chars
  dmBody?: string;
  emailSubject?: string;
  emailBody?: string;

  // Tracking
  trackingToken?: string;          // unique slug for redirect tracker
  registeredAt?: any;
  repliedAt?: any;

  // Timestamps
  createdAt?: any;
  updatedAt?: any;
  sentAt?: any;
  lastFollowUpAt?: any;
  followUpCount?: number;
}

export interface SendDoc {
  id: string;
  prospectId: string;
  channel: Channel;
  linkedinAccountId?: string;
  body: string;                    // exact content sent
  subject?: string;                // email only
  step: "initial" | "followup_t3" | "followup_t1" | "followup_t0";
  success: boolean;
  error?: string;
  responseMeta?: Record<string, unknown>;
  sentAt: any;
}

export interface ActivityLogDoc {
  type: string;
  message: string;
  metadata?: Record<string, unknown>;
  timestamp: any;
}
