import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyA8-ysxPXqsyAdiH6wx2H9TDDwLfqpGtCg",
  authDomain: "webinarpush.firebaseapp.com",
  projectId: "webinarpush",
  storageBucket: "webinarpush.firebasestorage.app",
  messagingSenderId: "658740769677",
  appId: "1:658740769677:web:6c43f25d7789c042f283c4",
  measurementId: "G-M7C9L002XP",
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export default app;
