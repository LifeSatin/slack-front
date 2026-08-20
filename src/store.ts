import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { nowIso } from './utils.js';

export type UserLink = { teamId: string; slackUserId: string; internalUserId: number; slackEmail: string | null; calendarConnected: boolean; linkedAt: string };
export type ChannelLink = { teamId: string; channelId: string; internalRoomId: number; createdBySlackUserId: string; createdAt: string };
export type ActiveNegotiation = { teamId: string; channelId: string; roomId: number; requesterSlackUserId: string; participantSlackIds: string; requestText: string; requestKey: string; parentTs: string | null; sessionId: string | null; phase: string; status: string; slotJson: string | null; createdAt: string; updatedAt: string };

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    this.migrate();
  }
  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_links (team_id TEXT NOT NULL, slack_user_id TEXT NOT NULL, internal_user_id INTEGER NOT NULL UNIQUE, slack_email TEXT, calendar_connected INTEGER NOT NULL DEFAULT 1, linked_at TEXT NOT NULL, PRIMARY KEY(team_id, slack_user_id));
      CREATE TABLE IF NOT EXISTS channel_links (team_id TEXT NOT NULL, channel_id TEXT NOT NULL, internal_room_id INTEGER NOT NULL, created_by_slack_user_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(team_id, channel_id));
      CREATE TABLE IF NOT EXISTS processed_requests (request_key TEXT PRIMARY KEY, kind TEXT NOT NULL, processed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_states (state TEXT PRIMARY KEY, team_id TEXT NOT NULL, slack_user_id TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);
      CREATE TABLE IF NOT EXISTS negotiations (request_key TEXT PRIMARY KEY, team_id TEXT NOT NULL, channel_id TEXT NOT NULL, room_id INTEGER NOT NULL, requester_slack_user_id TEXT NOT NULL, participant_slack_ids TEXT NOT NULL, request_text TEXT NOT NULL, parent_ts TEXT, session_id TEXT UNIQUE, phase TEXT NOT NULL, status TEXT NOT NULL, slot_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_negotiation_per_room ON negotiations(room_id) WHERE status IN ('accepted','running');
      CREATE TABLE IF NOT EXISTS delivered_events (event_key TEXT PRIMARY KEY, delivered_at TEXT NOT NULL);
    `);
  }
  close() { this.db.close(); }
  getUser(teamId: string, slackUserId: string): UserLink | undefined {
    const r = this.db.prepare('SELECT team_id teamId, slack_user_id slackUserId, internal_user_id internalUserId, slack_email slackEmail, calendar_connected calendarConnected, linked_at linkedAt FROM user_links WHERE team_id=? AND slack_user_id=?').get(teamId, slackUserId) as any;
    return r ? { ...r, calendarConnected: Boolean(r.calendarConnected) } : undefined;
  }
  linkUser(teamId: string, slackUserId: string, internalUserId: number, email?: string) {
    this.db.prepare('INSERT INTO user_links VALUES(?,?,?,?,1,?) ON CONFLICT(team_id,slack_user_id) DO UPDATE SET internal_user_id=excluded.internal_user_id, slack_email=excluded.slack_email, calendar_connected=1, linked_at=excluded.linked_at').run(teamId, slackUserId, internalUserId, email ?? null, nowIso());
  }
  getUsers(teamId: string, slackIds: string[]) { return slackIds.map((id) => this.getUser(teamId, id)).filter((x): x is UserLink => Boolean(x)); }
  getChannel(teamId: string, channelId: string): ChannelLink | undefined { return this.db.prepare('SELECT team_id teamId, channel_id channelId, internal_room_id internalRoomId, created_by_slack_user_id createdBySlackUserId, created_at createdAt FROM channel_links WHERE team_id=? AND channel_id=?').get(teamId, channelId) as ChannelLink | undefined; }
  linkChannel(teamId: string, channelId: string, roomId: number, by: string) { this.db.prepare('INSERT OR IGNORE INTO channel_links VALUES(?,?,?,?,?)').run(teamId, channelId, roomId, by, nowIso()); return this.getChannel(teamId, channelId)!; }
  claim(key: string, kind: string) { try { this.db.prepare('INSERT INTO processed_requests VALUES(?,?,?)').run(key, kind, nowIso()); return true; } catch { return false; } }
  createOAuthState(state: string, teamId: string, slackUserId: string, expiresAt: string) { this.db.prepare('INSERT INTO oauth_states VALUES(?,?,?,?,NULL)').run(state, teamId, slackUserId, expiresAt); }
  consumeOAuthState(state: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT team_id teamId, slack_user_id slackUserId, expires_at expiresAt, used_at usedAt FROM oauth_states WHERE state=?').get(state) as any;
      if (!row || row.usedAt || Date.parse(row.expiresAt) <= Date.now()) { this.db.exec('ROLLBACK'); return undefined; }
      this.db.prepare('UPDATE oauth_states SET used_at=? WHERE state=?').run(nowIso(), state);
      this.db.exec('COMMIT'); return row as { teamId: string; slackUserId: string; expiresAt: string };
    } catch (e) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw e; }
  }
  createNegotiation(n: Omit<ActiveNegotiation, 'parentTs'|'sessionId'|'phase'|'status'|'slotJson'|'createdAt'|'updatedAt'>) { const t=nowIso(); this.db.prepare('INSERT INTO negotiations VALUES(?,?,?,?,?,?,?,NULL,NULL,?,?,NULL,?,?)').run(n.requestKey,n.teamId,n.channelId,n.roomId,n.requesterSlackUserId,n.participantSlackIds,n.requestText,'dispatching','accepted',t,t); }
  setParent(key: string, ts: string) { this.db.prepare('UPDATE negotiations SET parent_ts=?, updated_at=? WHERE request_key=?').run(ts,nowIso(),key); }
  getActiveByRoom(roomId: number): ActiveNegotiation | undefined { return this.db.prepare("SELECT team_id teamId,channel_id channelId,room_id roomId,requester_slack_user_id requesterSlackUserId,participant_slack_ids participantSlackIds,request_text requestText,request_key requestKey,parent_ts parentTs,session_id sessionId,phase,status,slot_json slotJson,created_at createdAt,updated_at updatedAt FROM negotiations WHERE room_id=? AND status IN ('accepted','running') ORDER BY created_at LIMIT 1").get(roomId) as ActiveNegotiation|undefined; }
  getBySession(sessionId: string): ActiveNegotiation | undefined { return this.db.prepare('SELECT team_id teamId,channel_id channelId,room_id roomId,requester_slack_user_id requesterSlackUserId,participant_slack_ids participantSlackIds,request_text requestText,request_key requestKey,parent_ts parentTs,session_id sessionId,phase,status,slot_json slotJson,created_at createdAt,updated_at updatedAt FROM negotiations WHERE session_id=?').get(sessionId) as ActiveNegotiation|undefined; }
  getLatest(teamId: string, channelId: string): ActiveNegotiation | undefined { return this.db.prepare('SELECT team_id teamId,channel_id channelId,room_id roomId,requester_slack_user_id requesterSlackUserId,participant_slack_ids participantSlackIds,request_text requestText,request_key requestKey,parent_ts parentTs,session_id sessionId,phase,status,slot_json slotJson,created_at createdAt,updated_at updatedAt FROM negotiations WHERE team_id=? AND channel_id=? ORDER BY created_at DESC LIMIT 1').get(teamId,channelId) as ActiveNegotiation|undefined; }
  listActive(): ActiveNegotiation[] { return this.db.prepare("SELECT team_id teamId,channel_id channelId,room_id roomId,requester_slack_user_id requesterSlackUserId,participant_slack_ids participantSlackIds,request_text requestText,request_key requestKey,parent_ts parentTs,session_id sessionId,phase,status,slot_json slotJson,created_at createdAt,updated_at updatedAt FROM negotiations WHERE status IN ('accepted','running')").all() as unknown as ActiveNegotiation[]; }
  bindSession(roomId: number, sessionId: string, phase: string) { this.db.prepare("UPDATE negotiations SET session_id=?,phase=?,status='running',updated_at=? WHERE request_key=(SELECT request_key FROM negotiations WHERE room_id=? AND status IN ('accepted','running') ORDER BY created_at LIMIT 1)").run(sessionId,phase,nowIso(),roomId); return this.getBySession(sessionId); }
  updatePhase(sessionId: string, phase: string) { this.db.prepare("UPDATE negotiations SET phase=?,status='running',updated_at=? WHERE session_id=? AND status NOT IN ('succeeded','failed')").run(phase,nowIso(),sessionId); }
  finish(sessionId: string, status: 'succeeded'|'failed', slot: unknown) { this.db.prepare('UPDATE negotiations SET status=?,slot_json=?,updated_at=? WHERE session_id=?').run(status,slot?JSON.stringify(slot):null,nowIso(),sessionId); }
  failRequest(requestKey: string) { this.db.prepare("UPDATE negotiations SET status='failed',slot_json=NULL,updated_at=? WHERE request_key=?").run(nowIso(),requestKey); }
  deliverOnce(key: string) { try { this.db.prepare('INSERT INTO delivered_events VALUES(?,?)').run(key,nowIso()); return true; } catch { return false; } }
}
