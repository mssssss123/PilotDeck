import express from 'express';
import {
  readProjectWikiFile,
  readProjectWikiPayload,
  readProjectWikiSnapshot,
  resolveProjectWikiRoot,
  updateProjectWikiConflictStatus,
} from '../services/projectWikiService.js';
import { normalizeRefreshMaxHistoricalTurns } from '../services/projectWikiRefreshLimits.js';
import { getPilotDeckGateway } from '../pilotdeck-bridge.js';

const router = express.Router();

router.get('/snapshot', async (req, res) => {
  try {
    const snapshot = await readProjectWikiSnapshot(req.query.projectPath, {
      traceLimit: req.query.traceLimit,
    });
    res.json({ success: true, snapshot });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

router.get('/file', async (req, res) => {
  try {
    const file = await readProjectWikiFile(req.query.projectPath, req.query.path);
    res.json({ success: true, file });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

router.get('/payload', async (req, res) => {
  try {
    const payload = await readProjectWikiPayload(req.query.projectPath, req.query.path);
    res.json({ success: true, payload });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

router.get('/root', async (req, res) => {
  try {
    res.json({ success: true, ...await resolveProjectWikiRoot(req.query.projectPath) });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

router.post('/refresh', async (req, res) => {
  try {
    const projectPath = req.body?.projectPath ?? req.query.projectPath;
    if (typeof projectPath !== 'string' || !projectPath.trim()) {
      throw new Error('projectPath is required');
    }
    const resolved = await resolveProjectWikiRoot(projectPath);
    const gateway = await getPilotDeckGateway();
    if (typeof gateway.projectWikiRefresh !== 'function') {
      res.status(501).json({
        success: false,
        error: 'project_wiki_refresh_unavailable',
        message: 'The connected PilotDeck gateway does not expose ProjectWiki refresh.',
      });
      return;
    }
    const result = await gateway.projectWikiRefresh({
      projectKey: resolved.projectPath,
      reason: 'dashboard_refresh',
      maxHistoricalTurns: normalizeRefreshMaxHistoricalTurns(
        req.body?.maxHistoricalTurns ?? req.query.maxHistoricalTurns,
      ),
    });
    if (result.error) {
      res.status(500).json({ success: false, error: result.error.message, result });
      return;
    }
    res.json({ success: true, result });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

router.patch('/conflict', async (req, res) => {
  try {
    const conflict = await updateProjectWikiConflictStatus(
      req.body?.projectPath ?? req.query.projectPath,
      req.body?.conflictId ?? req.query.conflictId,
      req.body?.status ?? req.query.status,
    );
    res.json({ success: true, conflict });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

export default router;
