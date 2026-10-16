export const kpis = [
  { label: "At-risk customers", value: "342", delta: "-8.2% vs last mo" },
  { label: "Pending approvals", value: "14", delta: "4 urgent" },
  { label: "Recovered revenue", value: "$42,850", delta: "+12.4% vs last mo" },
] as const;

export const attentionList = [
  { email: "sophie.martin@gmail.com", detail: "64d inactive · $349 LTV", action: "Review" },
  { email: "marcus.vance@outlook.com", detail: "62d inactive · $528 LTV", action: "Review" },
  { email: "charlotte.berg@icloud.com", detail: "45d inactive · $610 LTV", action: "Review" },
  { email: "liam.chen@fastmail.fm", detail: "51d inactive · $195 LTV", action: "Review" },
  { email: "emma.watson@design.co", detail: "52d inactive · $415 LTV", action: "Review" },
] as const;
