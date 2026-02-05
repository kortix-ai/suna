export const COMMON_TAGS = {
  Project: "suna",
  ManagedBy: "pulumi",
  "map-migrated": "migDTKWJGT6A7",
} as const;

export * from "./types";
export * from "./ecs";
export * from "./compute";
export * from "./autoscaling";
export * from "./monitoring";
export * from "./iam";
export * from "./disaster-recovery";
