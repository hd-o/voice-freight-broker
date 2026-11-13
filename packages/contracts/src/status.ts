import { z } from "zod";

export const statusSchema = z.object({
  service: z.enum(["api", "tools"]),
  database: z.literal("ready"),
});

export type Status = z.infer<typeof statusSchema>;
