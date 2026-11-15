import type { DemoCarrier } from "./caller-briefing";

export const demoCarriers: DemoCarrier[] = [
  {
    name: "Summit Transport",
    mcNumber: "123456",
    preferredRoute: "Dallas, TX → Atlanta, GA",
    preferredEquipment: "Dry van",
  },
  {
    name: "Harbor Logistics",
    mcNumber: "234567",
    preferredRoute: "Memphis, TN → Denver, CO",
    preferredEquipment: "Reefer",
  },
  {
    name: "Prairie Trucking",
    mcNumber: "345678",
    verificationNote: "Invalid Carrier: Verification will fail",
  },
];
