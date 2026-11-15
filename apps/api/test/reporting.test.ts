import { expect, it } from "vitest";
import { callSchema, callsSchema, loadSchema } from "@voice-freight/contracts/calls";
import { describeOutcome, summarizeCalls } from "@voice-freight/contracts/reporting";
import records from "../../web/data/calls.json";

const calls = callsSchema.parse(records);

it("validates timestamp chronology independently of ISO fractional precision", (): void => {
  const timestamp = "2026-11-11T16:42:00Z";
  const fraction = "2026-11-11T16:42:00.500Z";

  expect(
    callSchema.safeParse({
      ...records[0],
      startedAt: fraction,
      endedAt: timestamp,
    }).success,
  ).toBe(false);

  const call = callSchema.parse({
    ...records[0],
    startedAt: timestamp,
    endedAt: fraction,
  });

  expect(summarizeCalls([call]).averageDurationSeconds).toBe(0.5);

  expect(
    loadSchema.safeParse({
      ...records[0].loads[0],
      pickupAt: fraction,
      deliveryAt: timestamp,
    }).success,
  ).toBe(false);

  expect(
    loadSchema.safeParse({
      ...records[0].loads[0],
      pickupAt: timestamp,
      deliveryAt: fraction,
    }).success,
  ).toBe(true);
});

it("validates the bundled public sample records and their references", (): void => {
  expect(calls.every((call): boolean => call.source === "Sample" && call.endedAt !== null)).toBe(true);
  expect(callsSchema.safeParse([...records, records[0]]).success).toBe(false);

  expect(
    callSchema.safeParse({
      ...records[0],
      agreements: [{ ...records[0].agreements[0], loadId: "missing" }],
    }).success,
  ).toBe(false);

  expect(
    callSchema.safeParse({
      ...records[0],
      loads: [{ ...records[0].loads[0], postedRateCents: 1.5 }],
    }).success,
  ).toBe(false);
});

it("uses the same call population for history, duration, sentiment and agreement reporting", (): void => {
  const report = summarizeCalls(calls);

  expect(report).toMatchObject({
    callCount: 8,
    durationCount: 8,
    averageDurationSeconds: 101.625,
    matchedCallCount: 5,
    agreementCallCount: 3,
    agreementRate: 0.6,
    finalAgreementCount: 4,
    averageVarianceCents: 9500,
  });

  expect(
    report.sentiments.map(({ label, count }): { label: typeof label; count: number } => ({ label, count })),
  ).toEqual([
    { label: "Positive", count: 3 },
    { label: "Neutral", count: 1 },
    { label: "Negative", count: 1 },
    { label: "Unknown", count: 3 },
  ]);
});

it("counts calls once and excludes unresolved errors only when no agreement survived", (): void => {
  const retainedCall = calls.find((call): boolean => call.id === "retained");
  const error = calls.find((call): boolean => call.id === "error");

  if (!retainedCall || !error) {
    throw new Error("Required error fixtures are missing");
  }

  expect(describeOutcome(retainedCall)).toBe("Agreement reached");

  expect(summarizeCalls([retainedCall, error])).toMatchObject({
    matchedCallCount: 1,
    agreementCallCount: 1,
    agreementRate: 1,
  });

  expect(summarizeCalls([calls[0]])).toMatchObject({
    matchedCallCount: 1,
    agreementCallCount: 1,
    finalAgreementCount: 2,
  });
});

it("excludes cancelled and superseded agreements and preserves signed variance", (): void => {
  const harbor = calls.find((call): boolean => call.id === "harbor");

  if (!harbor) {
    throw new Error("Required agreement history fixture is missing");
  }

  expect(summarizeCalls([harbor])).toMatchObject({
    finalAgreementCount: 1,
    averageVarianceCents: 8000,
  });

  const cancellation = callSchema.parse({
    ...harbor,
    agreements: harbor.agreements.map((agreement): typeof agreement => ({
      ...agreement,
      status: "cancelled",
    })),
    outcomeReason: "All agreements cancelled",
  });

  expect(describeOutcome(cancellation)).toBe("All agreements cancelled");

  expect(summarizeCalls([cancellation])).toMatchObject({
    matchedCallCount: 1,
    agreementRate: 0,
    finalAgreementCount: 0,
    averageVarianceCents: null,
  });

  const discount = callSchema.parse({
    ...harbor,
    agreements: [{ ...harbor.agreements[1], rateCents: 100000 }],
  });

  expect(summarizeCalls([discount]).averageVarianceCents).toBe(-10000);
});

it("shows unavailable denominators and omits active sessions from end-of-call metrics", (): void => {
  expect(summarizeCalls([])).toMatchObject({
    callCount: 0,
    durationCount: 0,
    averageDurationSeconds: null,
    agreementRate: null,
    averageVarianceCents: null,
  });

  expect(summarizeCalls([calls[3]])).toMatchObject({
    matchedCallCount: 0,
    agreementRate: null,
  });

  const activeCall = callSchema.parse({
    ...calls[0],
    source: "Live",
    endedAt: null,
  });

  expect(summarizeCalls([activeCall])).toMatchObject({
    callCount: 1,
    durationCount: 0,
    matchedCallCount: 0,
    finalAgreementCount: 0,
    agreementRate: null,
  });
});
