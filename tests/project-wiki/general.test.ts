import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

test("ProjectWiki dashboard service rejects general chat", async () => {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-general-projectwiki-"));
  const previousPilotHome = process.env.PILOT_HOME;
  process.env.PILOT_HOME = pilotHome;
  try {
    const service = await import(
      `${pathToFileURL(join(process.cwd(), "ui/server/services/projectWikiService.js")).href}?t=${Date.now()}`
    ) as {
      resolveProjectWikiRoot(projectPath: string): Promise<unknown>;
    };

    await assert.rejects(
      () => service.resolveProjectWikiRoot("general"),
      /ProjectWiki is not available in general chat/,
    );
    await assert.rejects(
      () => service.resolveProjectWikiRoot(pilotHome),
      /ProjectWiki is not available in general chat/,
    );
  } finally {
    if (previousPilotHome === undefined) {
      delete process.env.PILOT_HOME;
    } else {
      process.env.PILOT_HOME = previousPilotHome;
    }
    await rm(pilotHome, { recursive: true, force: true });
  }
});
