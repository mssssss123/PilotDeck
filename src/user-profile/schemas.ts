import {
  USER_PROFILE_CATEGORIES,
  type UserProfileCategory,
} from "./types.js";

export type UserProfileExtractOutput = {
  hasUserProfileSignal?: boolean;
  candidates?: Array<{
    category?: UserProfileCategory;
    content?: string;
    evidence?: string;
    confidence?: number;
    reason?: string;
  }>;
  removals?: Array<{
    targetDescription?: string;
    evidence?: string;
    reason?: string;
  }>;
  skipped?: Array<{ reason?: string; evidence?: string }>;
};

export type UserProfileMergeOutput = {
  operations?: Array<{
    op?: "add" | "replace" | "remove" | "skip";
    targetId?: string;
    category?: UserProfileCategory;
    content?: string;
    confidence?: number;
    sourceCandidateIndexes?: number[];
    reason?: string;
  }>;
  notes?: string;
};

export const userProfileExtractOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    hasUserProfileSignal: { type: "boolean" },
    candidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          category: { type: "string", enum: USER_PROFILE_CATEGORIES },
          content: { type: "string" },
          evidence: { type: "string" },
          confidence: { type: "number" },
          reason: { type: "string" },
        },
      },
    },
    removals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          targetDescription: { type: "string" },
          evidence: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
    skipped: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          reason: { type: "string" },
          evidence: { type: "string" },
        },
      },
    },
  },
};

export const userProfileMergeOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    operations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          op: { type: "string", enum: ["add", "replace", "remove", "skip"] },
          targetId: { type: "string" },
          category: { type: "string", enum: USER_PROFILE_CATEGORIES },
          content: { type: "string" },
          confidence: { type: "number" },
          sourceCandidateIndexes: { type: "array", items: { type: "number" } },
          reason: { type: "string" },
        },
      },
    },
    notes: { type: "string" },
  },
};

export function isUserProfileExtractOutput(value: unknown): value is UserProfileExtractOutput {
  if (!isRecord(value)) return false;
  if (value.hasUserProfileSignal !== undefined && typeof value.hasUserProfileSignal !== "boolean") return false;
  if (value.candidates !== undefined && !isArrayOf(value.candidates, isExtractCandidate)) return false;
  if (value.removals !== undefined && !isArrayOf(value.removals, isRemovalRequest)) return false;
  if (value.skipped !== undefined && !isArrayOf(value.skipped, isSkippedItem)) return false;
  return true;
}

export function isUserProfileMergeOutput(value: unknown): value is UserProfileMergeOutput {
  if (!isRecord(value)) return false;
  if (value.operations !== undefined && !isArrayOf(value.operations, isMergeOperation)) return false;
  if (value.notes !== undefined && typeof value.notes !== "string") return false;
  return true;
}

function isExtractCandidate(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.category !== undefined && !isUserProfileCategory(value.category)) return false;
  if (value.content !== undefined && typeof value.content !== "string") return false;
  if (value.evidence !== undefined && typeof value.evidence !== "string") return false;
  if (value.reason !== undefined && typeof value.reason !== "string") return false;
  if (value.confidence !== undefined && typeof value.confidence !== "number") return false;
  return true;
}

function isMergeOperation(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.op !== undefined && !["add", "replace", "remove", "skip"].includes(String(value.op))) return false;
  if (value.targetId !== undefined && typeof value.targetId !== "string") return false;
  if (value.category !== undefined && !isUserProfileCategory(value.category)) return false;
  if (value.content !== undefined && typeof value.content !== "string") return false;
  if (value.confidence !== undefined && typeof value.confidence !== "number") return false;
  if (value.reason !== undefined && typeof value.reason !== "string") return false;
  if (value.sourceCandidateIndexes !== undefined && !isArrayOf(value.sourceCandidateIndexes, (item) => typeof item === "number")) {
    return false;
  }
  return true;
}

function isSkippedItem(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.reason !== undefined && typeof value.reason !== "string") return false;
  if (value.evidence !== undefined && typeof value.evidence !== "string") return false;
  return true;
}

function isRemovalRequest(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.targetDescription !== undefined && typeof value.targetDescription !== "string") return false;
  if (value.evidence !== undefined && typeof value.evidence !== "string") return false;
  if (value.reason !== undefined && typeof value.reason !== "string") return false;
  return true;
}

function isUserProfileCategory(value: unknown): value is UserProfileCategory {
  return typeof value === "string" && USER_PROFILE_CATEGORIES.includes(value as UserProfileCategory);
}

function isArrayOf(value: unknown, predicate: (item: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(predicate);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
