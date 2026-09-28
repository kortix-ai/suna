import { z } from "zod";
import { core_deploymentSchema } from "./core-deployment";
import { integrations_channelsSchema } from "./integrations-channels";
import { llm_billingSchema } from "./llm-billing";
import { sandbox_provisioningSchema } from "./sandbox-provisioning";
import { platform_servicesSchema } from "./platform-services";
import { observabilitySchema } from "./observability";
export const envSchema = z.object({
  ...core_deploymentSchema,
  ...integrations_channelsSchema,
  ...llm_billingSchema,
  ...sandbox_provisioningSchema,
  ...platform_servicesSchema,
  ...observabilitySchema,
});
export type Env = z.infer<typeof envSchema>;
