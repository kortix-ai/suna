import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// The run watchdog: settles runs whose prepare, launch or poll action a deploy or restart interrupted.
crons.interval("run watchdog", { minutes: 5 }, internal.runs.sweep, {});

export default crons;
