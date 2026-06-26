import type { CanonicalMessage } from "../model/index.js";
import type {
  UserProfileContextInput,
  UserProfileDiagnostic,
  UserProfileResolver,
} from "./types.js";

export type UserProfileAttachmentBuilderInput = UserProfileContextInput;

export type UserProfileAttachmentBuilderResult = {
  attachments: CanonicalMessage[];
  diagnostics: UserProfileDiagnostic[];
};

export class UserProfileAttachmentBuilder {
  constructor(private readonly resolver: UserProfileResolver) {}

  async build(input: UserProfileAttachmentBuilderInput): Promise<UserProfileAttachmentBuilderResult> {
    if (input.signal?.aborted) return { attachments: [], diagnostics: [] };
    try {
      const result = await this.resolver.getContext(input);
      if (!result.systemContext || result.systemContext.trim().length === 0) {
        return { attachments: [], diagnostics: result.diagnostics ?? [] };
      }
      return {
        attachments: [{
          role: "user",
          content: [{
            type: "text",
            text: `<user-profile-context>\n${result.systemContext.trim()}\n</user-profile-context>`,
          }],
        }],
        diagnostics: result.diagnostics ?? [],
      };
    } catch (error) {
      return {
        attachments: [],
        diagnostics: [{
          code: "user_profile_store_error",
          severity: "warning",
          message: `UserProfile context failed: ${error instanceof Error ? error.message : String(error)}`,
        }],
      };
    }
  }
}
