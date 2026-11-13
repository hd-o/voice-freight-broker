import type { LoadDetails } from "./load-summary";
export const firstLoad: LoadDetails = {
  route: "Dallas → Atlanta",
  rate: "$2,450",
  comparison: "$150 above posted rate",
  snapshot: [
    "NS-1042 · 53 ft dry van · 781 miles",
    "Pickup Nov 13, 8:00 AM CST",
    "Delivery Nov 14, 2:00 PM EST",
    "General merchandise · 24,000 lb",
  ],
  negotiation: [
    { label: "Posted quote", value: "$2,300" },
    { label: "Carrier offer", value: "$2,600" },
    { label: "Broker counter", value: "$2,450" },
    { label: "Accepted", value: "$2,450", emphasized: true },
  ],
};
export const secondLoad: LoadDetails = {
  route: "Memphis → Denver",
  rate: "No agreement",
  comparison: "No final rate accepted",
  snapshot: [
    "NS-1048 · 53 ft dry van · 1,094 miles",
    "Pickup Nov 14, 9:00 AM CST",
    "Delivery Nov 16, 2:00 PM MST",
    "Packaged goods · 32,000 lb",
  ],
  negotiation: [
    { label: "Posted quote", value: "$2,800" },
    { label: "Carrier offer", value: "$3,200" },
    { label: "Broker counter", value: "$2,950" },
    { label: "Accepted", value: "—", emphasized: true },
  ],
};
