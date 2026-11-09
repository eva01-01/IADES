import express from 'express';
import type { Request, Response } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';
import { drizzle } from 'drizzle-orm/sql-js';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import sharp from 'sharp';
import { CredentialVault } from './secrets';
import { createSessionToken, hashPassword, hashSessionToken, normalizeEmail, validateAccountInput, verifyPassword } from './auth';
import { convertToCmyk, convertToSrgbJpeg, convertToSrgbPng } from './color-engine';
import { generateAIImage, generateAIText, validateProviderSettings } from './ai-provider';
import { defaultLocalAISettings, generateLocalDesignPlan, generateLocalPosterImage, generateLocalPosterPlan, generateLocalText, getLocalAIStatus, validateLocalAISettings } from './local-ai';
import { buildCommonsSearchUrl, normalizeCommonsResults, type CommonsCategory, type CommonsImageResult } from './commons-search';
import type { AIImageTask, AITextTask } from './ai-provider';
import type { DesignProject } from '../src/types';
import { productTemplates } from '../src/product-templates';
import * as schema from './schema';

const serverDirectory = path.dirname(process.argv[1] || process.cwd());
const require = createRequire(path.join(serverDirectory, 'server.cjs'));
const port = Number(process.env.PORT || 4174);
const lanMode = process.env.LAN_MODE === '1';
const host = process.env.HOST || (lanMode ? '0.0.0.0' : '127.0.0.1');
const dataDirectory = process.env.DESIGN_STUDIO_DATA || path.resolve(process.cwd(), 'data');
const assetDirectory = path.join(dataDirectory, 'assets');
const databaseFile = path.join(dataDirectory, 'studio.sqlite');
const app = express();
let cmykIccProfile: Buffer | undefined;
app.use(express.json({ limit: '80mb' }));

function json(value: unknown) {
  return JSON.stringify(value);
}

function parseProject(value: unknown): DesignProject | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const project = value as Partial<DesignProject>;
  if (typeof project.id !== 'string' || typeof project.name !== 'string' || !Number.isFinite(project.width) || !Number.isFinite(project.height) || !Array.isArray(project.nodes)) return undefined;
  if (project.nodes.some((node) => !node || typeof node.id !== 'string' || !['text', 'rect', 'ellipse', 'image'].includes(node.type) || ![node.x, node.y, node.width, node.height, node.rotation, node.opacity].every(Number.isFinite))) return undefined;
  return project as DesignProject;
}

async function start() {
  fs.mkdirSync(dataDirectory, { recursive: true });
  fs.mkdirSync(assetDirectory, { recursive: true });
  const SQL = await initSqlJs({ locateFile: (file: string) => require.resolve(`sql.js/dist/${file}`) });
  const db = fs.existsSync(databaseFile) ? new SQL.Database(fs.readFileSync(databaseFile)) : new SQL.Database();
  const migrationBackup = `${databaseFile}.pre-auth-migration.bak`;
  if (fs.existsSync(databaseFile) && !fs.existsSync(migrationBackup)) fs.copyFileSync(databaseFile, migrationBackup);
  db.run('PRAGMA foreign_keys = ON');
  const orm = drizzle(db, { schema });
  const persist = () => fs.writeFileSync(databaseFile, Buffer.from(db.export()));
  const ensureLegacySchema = () => {
    db.run('CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL)');
    db.run('CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL)');
    db.run('CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT NOT NULL)');
    const hasColumn = (table: string, column: string) => db.exec(`PRAGMA table_info(${table})`)[0]?.values.some((row) => row[1] === column) ?? false;
    if (!hasColumn('projects', 'owner_id')) db.run('ALTER TABLE projects ADD COLUMN owner_id TEXT REFERENCES accounts(id) ON DELETE CASCADE');
    if (!hasColumn('product_templates', 'owner_id')) {
      db.run('CREATE TABLE IF NOT EXISTS product_templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, product_type TEXT NOT NULL, definition TEXT NOT NULL, updated_at TEXT NOT NULL)');
      db.run('ALTER TABLE product_templates ADD COLUMN owner_id TEXT REFERENCES accounts(id) ON DELETE CASCADE');
    }
    db.run('CREATE TABLE IF NOT EXISTS design_documents (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, product_type TEXT NOT NULL, unit TEXT NOT NULL, physical_width_mm REAL NOT NULL, physical_height_mm REAL NOT NULL, artwork_width INTEGER NOT NULL, artwork_height INTEGER NOT NULL, printable_regions TEXT NOT NULL, print_settings TEXT NOT NULL, updated_at TEXT NOT NULL)');
    db.run('CREATE TABLE IF NOT EXISTS layers (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name TEXT NOT NULL, order_index INTEGER NOT NULL, visible INTEGER NOT NULL, locked INTEGER NOT NULL)');
    db.run('CREATE TABLE IF NOT EXISTS design_objects (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, layer_id TEXT NOT NULL REFERENCES layers(id) ON DELETE CASCADE, kind TEXT NOT NULL, order_index INTEGER NOT NULL, content TEXT NOT NULL)');
    db.run('CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE, local_path TEXT NOT NULL, mime_type TEXT NOT NULL, source_name TEXT, source_url TEXT, width INTEGER NOT NULL, height INTEGER NOT NULL, created_at TEXT NOT NULL)');
    if (!hasColumn('assets', 'owner_id')) db.run('ALTER TABLE assets ADD COLUMN owner_id TEXT REFERENCES accounts(id) ON DELETE CASCADE');
    db.run('CREATE TABLE IF NOT EXISTS product_templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, product_type TEXT NOT NULL, definition TEXT NOT NULL, updated_at TEXT NOT NULL)');
    db.run('CREATE TABLE IF NOT EXISTS printable_regions (id TEXT PRIMARY KEY, template_id TEXT NOT NULL REFERENCES product_templates(id) ON DELETE CASCADE, name TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL, width REAL NOT NULL, height REAL NOT NULL)');
    db.run('CREATE TABLE IF NOT EXISTS print_profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, resolution_dpi INTEGER NOT NULL, bleed_mm REAL NOT NULL, color_profile TEXT NOT NULL, settings TEXT NOT NULL)');
    db.run('CREATE TABLE IF NOT EXISTS export_jobs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, format TEXT NOT NULL, status TEXT NOT NULL, output_path TEXT, created_at TEXT NOT NULL)');
    db.run('CREATE TABLE IF NOT EXISTS ai_jobs (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE, kind TEXT NOT NULL, status TEXT NOT NULL, request TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL)');
    db.run('CREATE TABLE IF NOT EXISTS user_settings (id TEXT PRIMARY KEY, content TEXT NOT NULL, updated_at TEXT NOT NULL)');
    db.run('CREATE TABLE IF NOT EXISTS asset_attributions (id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE, source_name TEXT, source_url TEXT, attribution_text TEXT, created_at TEXT NOT NULL)');
    for (const template of productTemplates) {
      orm.insert(schema.productTemplates).values({ id: template.id, name: template.name, productType: template.kind, definition: json(template), updatedAt: new Date().toISOString() }).onConflictDoUpdate({ target: schema.productTemplates.id, set: { name: template.name, productType: template.kind, definition: json(template), updatedAt: new Date().toISOString() } }).run();
      orm.delete(schema.printableRegions).where(eq(schema.printableRegions.templateId, template.id)).run();
      if (template.regions.length) orm.insert(schema.printableRegions).values(template.regions.map((region) => ({ ...region, id: `${template.id}-${region.id}`, templateId: template.id }))).run();
    }
    persist();
  };
  ensureLegacySchema();
  const allProjects = (ownerId: string) => orm.select({ content: schema.projects.content }).from(schema.projects).where(eq(schema.projects.ownerId, ownerId)).orderBy(desc(schema.projects.updatedAt)).all().map(({ content }) => JSON.parse(content) as DesignProject);
  const writeProject = (project: DesignProject, ownerId: string) => {
    const existing = orm.select({ ownerId: schema.projects.ownerId }).from(schema.projects).where(eq(schema.projects.id, project.id)).get();
    if (existing && existing.ownerId !== ownerId) throw new Error('This project belongs to another account.');
    const updatedAt = typeof project.updatedAt === 'string' && Number.isFinite(Date.parse(project.updatedAt)) ? project.updatedAt : new Date().toISOString();
    const saved = { ...project, name: project.name.slice(0, 180), updatedAt };
    orm.insert(schema.projects).values({ id: saved.id, name: saved.name, content: json(saved), updatedAt, ownerId }).onConflictDoUpdate({ target: schema.projects.id, set: { name: saved.name, content: json(saved), updatedAt, ownerId } }).run();
    orm.insert(schema.designDocuments).values({
      id: saved.id,
      projectId: saved.id,
      productType: saved.productKind ?? 'custom',
      unit: saved.printSettings?.unit ?? 'mm',
      physicalWidthMm: saved.physicalWidthMm ?? saved.width / 96 * 25.4,
      physicalHeightMm: saved.physicalHeightMm ?? saved.height / 96 * 25.4,
      artworkWidth: Math.round(saved.width),
      artworkHeight: Math.round(saved.height),
      printableRegions: json(saved.printableRegions ?? []),
      printSettings: json(saved.printSettings ?? {}),
      updatedAt,
    }).onConflictDoUpdate({ target: schema.designDocuments.id, set: { productType: saved.productKind ?? 'custom', unit: saved.printSettings?.unit ?? 'mm', physicalWidthMm: saved.physicalWidthMm ?? saved.width / 96 * 25.4, physicalHeightMm: saved.physicalHeightMm ?? saved.height / 96 * 25.4, artworkWidth: Math.round(saved.width), artworkHeight: Math.round(saved.height), printableRegions: json(saved.printableRegions ?? []), printSettings: json(saved.printSettings ?? {}), updatedAt } }).run();
    orm.delete(schema.designObjects).where(eq(schema.designObjects.projectId, saved.id)).run();
    orm.delete(schema.layers).where(eq(schema.layers.projectId, saved.id)).run();
    const layerId = `${saved.id}-artwork`;
    orm.insert(schema.layers).values({ id: layerId, projectId: saved.id, name: 'Artwork', orderIndex: 0, visible: 1, locked: 0 }).run();
    if (saved.nodes.length) orm.insert(schema.designObjects).values(saved.nodes.map((node, orderIndex) => ({ id: node.id, projectId: saved.id, layerId, kind: node.type, orderIndex, content: json(node) }))).run();
    persist();
    return saved;
  };
  const vault = new CredentialVault();
  const readSetting = (id: string) => {
    const row = orm.select().from(schema.userSettings).where(eq(schema.userSettings.id, id)).get();
    if (!row) return undefined;
    try { return JSON.parse(row.content) as Record<string, unknown>; } catch { return undefined; }
  };
  const writeSetting = (id: string, value: Record<string, unknown>) => {
    const updatedAt = new Date().toISOString();
    orm.insert(schema.userSettings).values({ id, content: json(value), updatedAt }).onConflictDoUpdate({ target: schema.userSettings.id, set: { content: json(value), updatedAt } }).run();
    persist();
  };
  const safeCredentialExists = async (name: string) => {
    try { return Boolean(await vault.get(name)); } catch { return false; }
  };
  const getAISettings = () => {
    const configured = readSetting('ai-provider') ?? {};
    return validateProviderSettings({
      baseUrl: typeof configured.baseUrl === 'string' ? configured.baseUrl : 'https://api.openai.com/v1',
      textModel: typeof configured.textModel === 'string' ? configured.textModel : 'gpt-4o-mini',
      imageModel: typeof configured.imageModel === 'string' ? configured.imageModel : 'gpt-image-1',
    });
  };
  const getLocalSettings = () => validateLocalAISettings(readSetting('ai-local') ?? defaultLocalAISettings);
  const getAIMode = () => {
    if (lanMode) return 'local';
    const configured = readSetting('ai-mode')?.mode;
    if (configured === 'local' || configured === 'provider') return configured;
    return readSetting('ai-provider') ? 'provider' : 'local';
  };
  let pinterestState: { value: string; createdAt: number } | undefined;
  const pinterestResults = new Map<string, { imageUrl: string; sourceUrl: string; title: string; expiresAt: number }>();
  const commonsResults = new Map<string, CommonsImageResult & { expiresAt: number }>();
  const getPinterestConfig = () => readSetting('pinterest-config') ?? {};
  const getPinterestToken = async () => {
    let stored: { accessToken?: string; refreshToken?: string; expiresAt?: number };
    try {
      const savedTokens = await vault.get('pinterest-tokens');
      if (!savedTokens) throw new Error('No stored Pinterest authorization.');
      stored = JSON.parse(savedTokens) as typeof stored;
    } catch { throw new Error('Connect an authorized Pinterest account first.'); }
    if (stored.accessToken && Number(stored.expiresAt) > Date.now() + 60_000) return stored.accessToken;
    if (!stored.refreshToken) throw new Error('Pinterest authorization expired. Reconnect your account.');
    const config = getPinterestConfig();
    const clientId = typeof config.clientId === 'string' ? config.clientId : '';
    const clientSecret = await vault.get('pinterest-client-secret').catch(() => '');
    if (!clientId || !clientSecret) throw new Error('Pinterest app credentials are missing.');
    const response = await fetch('https://api.pinterest.com/v5/oauth/token', {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: stored.refreshToken }),
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!response.ok || typeof payload.access_token !== 'string') throw new Error('Pinterest token refresh failed. Reconnect your account.');
    const refreshed = { accessToken: payload.access_token, refreshToken: payload.refresh_token ?? stored.refreshToken, expiresAt: Date.now() + Math.max(60, payload.expires_in ?? 2_592_000) * 1000 };
    await vault.set('pinterest-tokens', JSON.stringify(refreshed));
    return refreshed.accessToken;
  };
  const storeImageAsset = async (projectId: string, ownerId: string, name: string, source: Buffer, attribution?: { sourceName: string; sourceUrl: string; attributionText?: string }) => {
    const project = orm.select({ id: schema.projects.id }).from(schema.projects).where(and(eq(schema.projects.id, projectId), eq(schema.projects.ownerId, ownerId))).get();
    if (!project) throw new Error('Project not found in this account.');
    const normalized = await sharp(source, { limitInputPixels: 80_000_000 }).rotate().png().toBuffer({ resolveWithObject: true });
    if (!normalized.info.width || !normalized.info.height || normalized.data.length > 30 * 1024 * 1024) throw new Error('Image dimensions or file size are not supported.');
    const id = crypto.randomUUID();
    const localPath = path.join(assetDirectory, `${id}.png`);
    fs.writeFileSync(localPath, normalized.data, { flag: 'wx' });
    const createdAt = new Date().toISOString();
    orm.insert(schema.assets).values({ id, projectId, localPath, mimeType: 'image/png', sourceName: attribution?.sourceName ?? name.slice(0, 240), sourceUrl: attribution?.sourceUrl ?? null, width: normalized.info.width, height: normalized.info.height, createdAt, ownerId }).run();
    if (attribution) orm.insert(schema.assetAttributions).values({ id: crypto.randomUUID(), assetId: id, sourceName: attribution.sourceName.slice(0, 240), sourceUrl: attribution.sourceUrl.slice(0, 1000), attributionText: (attribution.attributionText ?? `Pinterest Pin ${attribution.sourceName}`).slice(0, 1000), createdAt }).run();
    persist();
    return { id, src: `/api/assets/${id}`, sourceName: attribution?.sourceName ?? name, sourceUrl: attribution?.sourceUrl, width: normalized.info.width, height: normalized.info.height };
  };

  let setupToken = orm.select({ id: schema.accounts.id }).from(schema.accounts).get() ? undefined : crypto.randomBytes(6).toString('hex');
  let setupInProgress = false;
  const loginFailures = new Map<string, { count: number; firstAt: number }>();
  const sessionDurationMs = 30 * 24 * 60 * 60 * 1000;
  const cookieName = 'iadesign_session';
  const readCookie = (request: Request, name: string) => request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
  const requestOriginAllowed = (request: Request) => {
    const origin = request.get('origin');
    if (!origin) return false;
    try {
      const parsed = new URL(origin);
      const localAddresses = new Set(['localhost', '127.0.0.1', '::1', ...Object.values(os.networkInterfaces()).flatMap((entries) => (entries ?? []).filter((entry) => entry.family === 'IPv4').map((entry) => entry.address))]);
      return parsed.protocol === 'http:' && parsed.origin === `${request.protocol}://${request.get('host')}` && localAddresses.has(parsed.hostname.replace(/^::ffff:/, ''));
    } catch {
      return false;
    }
  };
  const publicUser = (account: { id: string; email: string; role: string }) => ({ id: account.id, email: account.email, role: account.role as 'owner' | 'member' });
  const userForRequest = (request: Request) => (request as Request & { authUser?: ReturnType<typeof publicUser> }).authUser;
  const issueSession = (userId: string, response: Response) => {
    const token = createSessionToken();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + sessionDurationMs);
    orm.insert(schema.sessions).values({ tokenHash: hashSessionToken(token), userId, expiresAt: expiresAt.toISOString(), createdAt: createdAt.toISOString() }).run();
    persist();
    response.setHeader('set-cookie', `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(sessionDurationMs / 1000)}`);
  };
  const resolveSession = (request: Request) => {
    const token = readCookie(request, cookieName);
    if (!token || !/^[A-Za-z0-9_-]{40,50}$/.test(token)) return undefined;
    const session = orm.select().from(schema.sessions).where(eq(schema.sessions.tokenHash, hashSessionToken(token))).get();
    if (!session || Date.parse(session.expiresAt) <= Date.now()) return undefined;
    const account = orm.select().from(schema.accounts).where(eq(schema.accounts.id, session.userId)).get();
    return account ? publicUser(account) : undefined;
  };
  app.get('/api/health', (_request, response) => response.json({ ok: true }));
  app.use('/api/auth', (request, response, next) => {
    response.setHeader('cache-control', 'no-store');
    if (lanMode && !['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !requestOriginAllowed(request)) return response.status(403).json({ error: 'Requests must come from this local studio origin.' });
    next();
  });
  app.get('/api/auth/status', (request, response) => response.json({ setupRequired: !orm.select({ id: schema.accounts.id }).from(schema.accounts).get(), lanMode, remoteAIAllowed: !lanMode, user: resolveSession(request) ?? null }));
  app.post('/api/auth/setup', async (request, response) => {
    const body = request.body ?? {};
    if (setupInProgress || !setupToken || orm.select({ id: schema.accounts.id }).from(schema.accounts).get()) return response.status(409).json({ error: 'Initial account setup is already complete.' });
    if (typeof body.setupCode !== 'string' || Buffer.byteLength(body.setupCode) !== Buffer.byteLength(setupToken) || !crypto.timingSafeEqual(Buffer.from(body.setupCode), Buffer.from(setupToken))) return response.status(403).json({ error: 'The one-time setup code is invalid. Read it from the server console.' });
    let input: ReturnType<typeof validateAccountInput>;
    try { input = validateAccountInput(body.email, body.password); } catch (error) { return response.status(400).json({ error: error instanceof Error ? error.message : 'Invalid account details.' }); }
    setupInProgress = true;
    let transactionStarted = false;
    try {
      const passwordHash = await hashPassword(input.password);
      if (orm.select({ id: schema.accounts.id }).from(schema.accounts).get()) return response.status(409).json({ error: 'Initial account setup is already complete.' });
      const account = { id: crypto.randomUUID(), email: input.email, passwordHash, role: 'owner', createdAt: new Date().toISOString() };
      db.run('BEGIN TRANSACTION');
      transactionStarted = true;
      orm.insert(schema.accounts).values(account).run();
      db.run('UPDATE projects SET owner_id = ? WHERE owner_id IS NULL', [account.id]);
      db.run('UPDATE assets SET owner_id = ? WHERE owner_id IS NULL', [account.id]);
      db.run("UPDATE product_templates SET owner_id = ? WHERE owner_id IS NULL AND id LIKE 'custom-%'", [account.id]);
      orm.delete(schema.sessions).run();
      db.run('COMMIT');
      transactionStarted = false;
      persist();
      setupToken = undefined;
      issueSession(account.id, response);
      return response.status(201).json({ user: publicUser(account) });
    } catch {
      if (transactionStarted) db.run('ROLLBACK');
      return response.status(500).json({ error: 'Unable to create the owner account. Existing local data was not intentionally removed.' });
    } finally {
      setupInProgress = false;
    }
  });
  app.post('/api/auth/login', async (request, response) => {
    const address = request.ip ?? request.socket.remoteAddress ?? 'unknown';
    const attempts = loginFailures.get(address);
    if (attempts && Date.now() - attempts.firstAt < 15 * 60_000 && attempts.count >= 10) return response.status(429).json({ error: 'Too many sign-in attempts. Wait 15 minutes and try again.' });
    const email = normalizeEmail(request.body?.email);
    const password = typeof request.body?.password === 'string' && request.body.password.length <= 128 ? request.body.password : '';
    const account = orm.select().from(schema.accounts).where(eq(schema.accounts.email, email)).get();
    const valid = account ? await verifyPassword(password, account.passwordHash) : false;
    if (!account || !valid) {
      const current = attempts && Date.now() - attempts.firstAt < 15 * 60_000 ? attempts : { count: 0, firstAt: Date.now() };
      loginFailures.set(address, { ...current, count: current.count + 1 });
      return response.status(401).json({ error: 'Email or password is incorrect.' });
    }
    loginFailures.delete(address);
    issueSession(account.id, response);
    return response.json({ user: publicUser(account) });
  });
  app.post('/api/auth/logout', (request, response) => {
    const token = readCookie(request, cookieName);
    if (token && /^[A-Za-z0-9_-]{40,50}$/.test(token)) orm.delete(schema.sessions).where(eq(schema.sessions.tokenHash, hashSessionToken(token))).run();
    response.setHeader('set-cookie', `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    persist();
    response.json({ ok: true });
  });
  app.use('/api', (request, response, next) => {
    response.setHeader('cache-control', 'no-store');
    if (lanMode && !['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !requestOriginAllowed(request)) return response.status(403).json({ error: 'Requests must come from this local studio origin.' });
    const user = resolveSession(request);
    if (!user) return response.status(401).json({ error: 'Sign in to access this studio.' });
    (request as Request & { authUser?: ReturnType<typeof publicUser> }).authUser = user;
    next();
  });
  app.get('/api/auth/users', (request, response) => {
    if (resolveSession(request)?.role !== 'owner') return response.status(403).json({ error: 'Only the owner can manage accounts.' });
    response.json(orm.select({ id: schema.accounts.id, email: schema.accounts.email, role: schema.accounts.role, createdAt: schema.accounts.createdAt }).from(schema.accounts).all());
  });
  app.post('/api/auth/users', async (request, response) => {
    if (userForRequest(request)?.role !== 'owner') return response.status(403).json({ error: 'Only the owner can create accounts.' });
    let input: ReturnType<typeof validateAccountInput>;
    try { input = validateAccountInput(request.body?.email, request.body?.password); } catch (error) { return response.status(400).json({ error: error instanceof Error ? error.message : 'Invalid account details.' }); }
    if (orm.select({ id: schema.accounts.id }).from(schema.accounts).where(eq(schema.accounts.email, input.email)).get()) return response.status(409).json({ error: 'An account with this email already exists.' });
    const account = { id: crypto.randomUUID(), email: input.email, passwordHash: await hashPassword(input.password), role: 'member', createdAt: new Date().toISOString() };
    orm.insert(schema.accounts).values(account).run();
    persist();
    response.status(201).json({ user: publicUser(account) });
  });
  app.delete('/api/auth/users/:id', (request, response) => {
    if (userForRequest(request)?.role !== 'owner') return response.status(403).json({ error: 'Only the owner can remove accounts.' });
    const account = orm.select().from(schema.accounts).where(eq(schema.accounts.id, request.params.id)).get();
    if (!account || account.role !== 'member') return response.status(404).json({ error: 'Member account not found.' });
    const ownedAssets = orm.select().from(schema.assets).where(eq(schema.assets.ownerId, account.id)).all();
    for (const asset of ownedAssets) {
      const assetPath = path.resolve(asset.localPath);
      if (path.dirname(assetPath) === path.resolve(assetDirectory) && path.basename(assetPath) === `${asset.id}.${path.extname(assetPath).slice(1)}`) fs.rmSync(assetPath, { force: true });
    }
    orm.delete(schema.accounts).where(eq(schema.accounts.id, account.id)).run();
    persist();
    response.status(204).end();
  });
  app.get('/api/ai/settings', async (_request, response) => response.json(lanMode ? { baseUrl: '', textModel: '', imageModel: '', mode: 'local', apiKeyConfigured: false, remoteAIAllowed: false } : { ...getAISettings(), apiKeyConfigured: await safeCredentialExists('ai-provider-api-key'), mode: getAIMode(), remoteAIAllowed: true }));
  app.put('/api/ai/settings', async (request, response) => {
    if (lanMode) return response.status(403).json({ error: 'Private LAN mode only supports locally hosted AI models.' });
    try {
      const settings = validateProviderSettings(request.body);
      const apiKey = request.body?.apiKey;
      if (typeof apiKey === 'string' && apiKey.trim()) {
        if (apiKey.length > 2000) return response.status(400).json({ error: 'API key is too long.' });
        await vault.set('ai-provider-api-key', apiKey.trim());
      } else if (request.body?.clearApiKey === true) {
        await vault.delete('ai-provider-api-key').catch(() => undefined);
      }
      if (request.body?.mode === 'local' || request.body?.mode === 'provider') writeSetting('ai-mode', { mode: request.body.mode });
      writeSetting('ai-provider', settings);
      response.json({ ...settings, apiKeyConfigured: await safeCredentialExists('ai-provider-api-key'), mode: getAIMode() });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : 'Unable to save provider configuration.' });
    }
  });
  app.get('/api/ai/local/settings', async (_request, response) => {
    const settings = getLocalSettings();
    response.json({ ...settings, status: await getLocalAIStatus(settings) });
  });
  app.put('/api/ai/local/settings', async (request, response) => {
    try {
      if (lanMode && request.body?.mode === 'provider') return response.status(403).json({ error: 'Private LAN mode only supports locally hosted AI models.' });
      const settings = validateLocalAISettings(request.body);
      writeSetting('ai-local', settings);
      if (request.body?.mode === 'provider' || request.body?.mode === 'local') writeSetting('ai-mode', { mode: request.body.mode });
      response.json({ ...settings, mode: getAIMode(), status: await getLocalAIStatus(settings) });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : 'Unable to save local AI settings.' });
    }
  });
  app.get('/api/ai/local/status', async (_request, response) => response.json(await getLocalAIStatus(getLocalSettings())));
  app.post('/api/ai/local/text', async (request, response) => {
    try {
      const settings = getLocalSettings();
      const status = await getLocalAIStatus(settings);
      if (!status.ollamaAvailable || !status.selectedTextModelAvailable) return response.status(503).json({ error: `Local text model ${settings.textModel} is not installed or Ollama is unavailable.` });
      response.json({ text: await generateLocalText(settings, request.body?.task, request.body?.prompt) });
    } catch (error) {
      response.status(502).json({ error: error instanceof Error ? error.message.slice(0, 500) : 'Local text generation failed.' });
    }
  });
  app.post('/api/ai/local/poster-plan', async (request, response) => {
    try {
      const settings = getLocalSettings();
      const status = await getLocalAIStatus(settings);
      if (!status.ollamaAvailable || !status.selectedTextModelAvailable) return response.status(503).json({ error: `Local text model ${settings.textModel} is not installed or Ollama is unavailable.` });
      response.json({ text: await generateLocalPosterPlan(settings, request.body?.prompt) });
    } catch (error) {
      response.status(502).json({ error: error instanceof Error ? error.message.slice(0, 500) : 'Local poster planning failed.' });
    }
  });
  app.post('/api/ai/local/product-plan', async (request, response) => {
    try {
      const settings = getLocalSettings();
      const status = await getLocalAIStatus(settings);
      if (!status.ollamaAvailable || !status.selectedTextModelAvailable) return response.status(503).json({ error: `Local text model ${settings.textModel} is not installed or Ollama is unavailable.` });
      response.json({ text: await generateLocalDesignPlan(settings, request.body?.prompt) });
    } catch (error) {
      response.status(502).json({ error: error instanceof Error ? error.message.slice(0, 500) : 'Local product-design planning failed.' });
    }
  });
  app.post('/api/ai/local/poster-image', async (request, response) => {
    const { projectId, prompt, allowBrandLogo } = request.body ?? {};
    const ownerId = userForRequest(request)!.id;
    if (typeof projectId !== 'string' || projectId.length > 80 || !orm.select().from(schema.projects).where(and(eq(schema.projects.id, projectId), eq(schema.projects.ownerId, ownerId))).get()) return response.status(400).json({ error: 'Save the current project before generating a local image.' });
    try {
      const settings = getLocalSettings();
      const status = await getLocalAIStatus(settings);
      if (!status.comfyAvailable || !status.selectedCheckpointAvailable) return response.status(503).json({ error: 'Start ComfyUI locally and choose an installed checkpoint in local AI settings.' });
      const generated = await generateLocalPosterImage(settings, prompt, fetch, allowBrandLogo === true);
      const metadata = await sharp(generated, { limitInputPixels: 80_000_000 }).metadata();
      if (!metadata.width || !metadata.height || !['png', 'jpeg', 'webp'].includes(metadata.format ?? '')) throw new Error('ComfyUI returned invalid image data.');
      const asset = await storeImageAsset(projectId, ownerId, `Local-AI-${Date.now()}.png`, generated);
      response.status(201).json({ ...asset, width: metadata.width, height: metadata.height });
    } catch (error) {
      response.status(502).json({ error: error instanceof Error ? error.message.slice(0, 500) : 'Local image generation failed.' });
    }
  });
  app.post('/api/ai/text', async (request, response) => {
    if (lanMode) return response.status(403).json({ error: 'Remote AI providers are disabled in private LAN mode; use the locally hosted models.' });
    const taskValue = request.body?.task;
    if (typeof taskValue !== 'string' || !['marketing', 'layout', 'variations', 'poster-plan'].includes(taskValue)) return response.status(400).json({ error: 'Choose a supported AI text task.' });
    const task = taskValue as AITextTask;
    try {
      const apiKey = await vault.get('ai-provider-api-key');
      if (!apiKey) return response.status(503).json({ error: 'Configure an AI provider API key in AI settings first.' });
      const text = await generateAIText(getAISettings(), apiKey, task, request.body?.prompt);
      response.json({ text });
    } catch (error) {
      response.status(502).json({ error: error instanceof Error ? error.message : 'AI text generation failed.' });
    }
  });
  app.post('/api/ai/image', async (request, response) => {
    if (lanMode) return response.status(403).json({ error: 'Remote AI providers are disabled in private LAN mode; use the locally hosted models.' });
    const { projectId, prompt, task, imageDataUrl } = request.body ?? {};
    const ownerId = userForRequest(request)!.id;
    if (typeof projectId !== 'string' || projectId.length > 80 || !orm.select().from(schema.projects).where(and(eq(schema.projects.id, projectId), eq(schema.projects.ownerId, ownerId))).get()) return response.status(400).json({ error: 'Save the current project before generating an image.' });
    try {
      const apiKey = await vault.get('ai-provider-api-key');
      if (!apiKey) return response.status(503).json({ error: 'Configure an AI provider API key in AI settings first.' });
      const generated = await generateAIImage(getAISettings(), apiKey, task as AIImageTask, prompt, imageDataUrl);
      const metadata = await sharp(generated.data, { limitInputPixels: 80_000_000 }).metadata();
      if (!metadata.width || !metadata.height || !['png', 'jpeg', 'webp'].includes(metadata.format ?? '')) throw new Error('AI provider returned invalid image data.');
      const asset = await storeImageAsset(projectId, ownerId, `AI-${Date.now()}.png`, generated.data);
      response.status(201).json({ ...asset, width: metadata.width, height: metadata.height });
    } catch (error) {
      response.status(502).json({ error: error instanceof Error ? error.message : 'AI image generation failed.' });
    }
  });
  app.get('/api/commons/search', async (request, response) => {
    const term = typeof request.query.term === 'string' ? request.query.term.trim() : '';
    const category = request.query.category === 'logo' ? 'logo' : request.query.category === 'content' ? 'content' : undefined;
    if (term.length < 2 || term.length > 200 || !category) return response.status(400).json({ error: 'Provide a 2–200 character search and choose content or logo.' });
    try {
      const result = await fetch(buildCommonsSearchUrl(term, category as CommonsCategory), { headers: { 'user-agent': 'AI-Design-Studio/1.1 (Wikimedia Commons attribution-aware search)' }, signal: AbortSignal.timeout(20_000) });
      if (!result.ok) return response.status(502).json({ error: `Wikimedia Commons search failed (${result.status}).` });
      const payload = await result.json();
      const items = normalizeCommonsResults(payload);
      for (const item of items) commonsResults.set(item.id, { ...item, expiresAt: Date.now() + 10 * 60_000 });
      for (const [id, item] of commonsResults) if (item.expiresAt < Date.now()) commonsResults.delete(id);
      while (commonsResults.size > 500) commonsResults.delete(commonsResults.keys().next().value!);
      response.json({ items, source: 'Wikimedia Commons', resultCount: items.length });
    } catch (error) {
      response.status(503).json({ error: error instanceof Error ? error.message : 'Wikimedia Commons search is unavailable.' });
    }
  });
  app.post('/api/commons/import', async (request, response) => {
    const { projectId, imageId } = request.body ?? {};
    const ownerId = userForRequest(request)!.id;
    if (typeof projectId !== 'string' || !orm.select().from(schema.projects).where(and(eq(schema.projects.id, projectId), eq(schema.projects.ownerId, ownerId))).get()) return response.status(400).json({ error: 'Save the current project before importing an image.' });
    if (typeof imageId !== 'string' || !/^\d{1,12}$/.test(imageId)) return response.status(400).json({ error: 'Select an image from the Commons search results.' });
    const image = commonsResults.get(imageId);
    if (!image || image.expiresAt < Date.now()) return response.status(400).json({ error: 'Run the Commons search again before importing this image.' });
    try {
      const result = await fetch(image.imageUrl, { redirect: 'error', headers: { 'user-agent': 'AI-Design-Studio/1.1 (Wikimedia Commons image import)' }, signal: AbortSignal.timeout(20_000) });
      if (!result.ok || !result.body || !result.headers.get('content-type')?.startsWith('image/')) return response.status(502).json({ error: 'The Commons image download failed or returned an unsupported file.' });
      const declaredSize = Number(result.headers.get('content-length'));
      if (declaredSize > 30 * 1024 * 1024) return response.status(413).json({ error: 'The Commons image exceeds the 30 MB limit.' });
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of result.body) {
        const data = Buffer.from(chunk);
        total += data.length;
        if (total > 30 * 1024 * 1024) return response.status(413).json({ error: 'The Commons image exceeds the 30 MB limit.' });
        chunks.push(data);
      }
      const attributionText = [image.license, image.licenseUrl, image.creator ? `Creator: ${image.creator}` : '', image.trademarked ? 'Trademark restrictions are indicated; check usage rights before commercial use.' : ''].filter(Boolean).join(' · ');
      const imported = await storeImageAsset(projectId, ownerId, image.title, Buffer.concat(chunks), { sourceName: image.title, sourceUrl: image.sourceUrl, attributionText });
      response.status(201).json({ ...imported, license: image.license, licenseUrl: image.licenseUrl, creator: image.creator, trademarked: image.trademarked });
    } catch (error) {
      response.status(502).json({ error: error instanceof Error ? error.message : 'Commons image import failed.' });
    }
  });
  app.get('/api/pinterest/status', async (_request, response) => {
    const config = getPinterestConfig();
    response.json({ clientIdConfigured: typeof config.clientId === 'string' && config.clientId.length > 0, clientSecretConfigured: await safeCredentialExists('pinterest-client-secret'), connected: await safeCredentialExists('pinterest-tokens'), redirectUri: `http://127.0.0.1:${port}/api/pinterest/callback` });
  });
  app.put('/api/pinterest/config', async (request, response) => {
    const clientId = request.body?.clientId;
    const clientSecret = request.body?.clientSecret;
    if (typeof clientId !== 'string' || clientId.length < 4 || clientId.length > 100) return response.status(400).json({ error: 'Enter a valid Pinterest app ID.' });
    if (typeof clientSecret === 'string' && clientSecret.length > 500) return response.status(400).json({ error: 'Pinterest app secret is too long.' });
    try {
      if (clientSecret?.trim()) await vault.set('pinterest-client-secret', clientSecret.trim());
      if (request.body?.clearCredentials === true) {
        await vault.delete('pinterest-client-secret').catch(() => undefined);
        await vault.delete('pinterest-tokens').catch(() => undefined);
      }
      writeSetting('pinterest-config', { clientId });
      response.json({ clientIdConfigured: true, clientSecretConfigured: await safeCredentialExists('pinterest-client-secret'), connected: await safeCredentialExists('pinterest-tokens'), redirectUri: `http://127.0.0.1:${port}/api/pinterest/callback` });
    } catch {
      response.status(500).json({ error: 'The operating-system credential store could not save the Pinterest credentials.' });
    }
  });
  app.post('/api/pinterest/authorize', async (_request, response) => {
    const config = getPinterestConfig();
    const clientId = typeof config.clientId === 'string' ? config.clientId : '';
    if (!clientId || !await safeCredentialExists('pinterest-client-secret')) return response.status(400).json({ error: 'Save your Pinterest app ID and secret first.' });
    const state = crypto.randomBytes(32).toString('hex');
    pinterestState = { value: state, createdAt: Date.now() };
    const redirectUri = `http://127.0.0.1:${port}/api/pinterest/callback`;
    const authorization = new URL('https://www.pinterest.com/oauth/');
    authorization.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'boards:read,pins:read', state }).toString();
    response.json({ url: authorization.toString() });
  });
  app.get('/api/pinterest/callback', async (request, response) => {
    const code = request.query.code;
    const state = request.query.state;
    const expectedState = pinterestState;
    pinterestState = undefined;
    const stateMatches = typeof state === 'string' && Boolean(expectedState) && Buffer.byteLength(state) === Buffer.byteLength(expectedState!.value) && crypto.timingSafeEqual(Buffer.from(state), Buffer.from(expectedState!.value));
    if (typeof code !== 'string' || !stateMatches || Date.now() - expectedState!.createdAt > 600_000) return response.status(400).type('text').send('Pinterest authorization could not be verified. Return to AI Design Studio and try again.');
    try {
      const config = getPinterestConfig();
      const clientId = String(config.clientId ?? '');
      const clientSecret = await vault.get('pinterest-client-secret');
      const redirectUri = `http://127.0.0.1:${port}/api/pinterest/callback`;
      const tokenResponse = await fetch('https://api.pinterest.com/v5/oauth/token', {
        method: 'POST',
        headers: { authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
        signal: AbortSignal.timeout(20_000),
      });
      const tokenPayload = await tokenResponse.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; expires_in?: number };
      if (!tokenResponse.ok || typeof tokenPayload.access_token !== 'string') return response.status(502).type('text').send('Pinterest did not issue an access token. Verify the registered redirect URI and app access.');
      await vault.set('pinterest-tokens', JSON.stringify({ accessToken: tokenPayload.access_token, refreshToken: tokenPayload.refresh_token, expiresAt: Date.now() + Math.max(60, tokenPayload.expires_in ?? 2_592_000) * 1000 }));
      response.type('html').send('<!doctype html><html><meta charset="utf-8"><title>Pinterest connected</title><body><p>Pinterest is connected. Return to AI Design Studio and close this page.</p></body></html>');
    } catch {
      response.status(502).type('text').send('Pinterest authorization failed. Verify app credentials and try again.');
    }
  });
  app.get('/api/pinterest/search', async (request, response) => {
    const term = typeof request.query.term === 'string' ? request.query.term.trim() : '';
    if (term.length < 2 || term.length > 200) return response.status(400).json({ error: 'Search terms must contain 2–200 characters.' });
    try {
      const accessToken = await getPinterestToken();
      const searchUrl = new URL('https://api.pinterest.com/v5/search/partner/pins');
      searchUrl.search = new URLSearchParams({ term, country_code: 'US', limit: '25' }).toString();
      const result = await fetch(searchUrl, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20_000) });
      const payload = await result.json().catch(() => ({})) as { items?: Array<Record<string, unknown>>; bookmark?: string };
      if (!result.ok) return response.status(result.status === 401 ? 401 : 502).json({ error: result.status === 403 ? 'Pinterest search access is restricted for this app. Request the required Pinterest API beta access.' : `Pinterest search failed (${result.status}).` });
      const items = (payload.items ?? []).flatMap((pin) => {
        const images = pin.media && typeof pin.media === 'object' ? (pin.media as { images?: Record<string, { url?: string }> }).images : undefined;
        const imageUrl = images?.['1200x']?.url ?? images?.['600x']?.url ?? images?.['400x300']?.url;
        if (typeof pin.id !== 'string' || !/^\d+$/.test(pin.id) || typeof imageUrl !== 'string') return [];
        const parsed = new URL(imageUrl);
        if (parsed.protocol !== 'https:' || parsed.hostname !== 'i.pinimg.com') return [];
        const sourceUrl = `https://www.pinterest.com/pin/${pin.id}/`;
        const title = typeof pin.title === 'string' ? pin.title : '';
        pinterestResults.set(pin.id, { imageUrl: parsed.toString(), sourceUrl, title, expiresAt: Date.now() + 10 * 60_000 });
        return [{ id: pin.id, title, description: typeof pin.description === 'string' ? pin.description : '', altText: typeof pin.alt_text === 'string' ? pin.alt_text : '', imageUrl: parsed.toString(), sourceUrl }];
      });
      for (const [id, pin] of pinterestResults) if (pin.expiresAt < Date.now()) pinterestResults.delete(id);
      while (pinterestResults.size > 500) pinterestResults.delete(pinterestResults.keys().next().value!);
      response.json({ items, bookmark: typeof payload.bookmark === 'string' ? payload.bookmark : undefined, betaAccessRequired: true });
    } catch (error) {
      response.status(503).json({ error: error instanceof Error ? error.message : 'Pinterest search is unavailable.' });
    }
  });
  app.post('/api/pinterest/import', async (request, response) => {
    const { projectId, pinId } = request.body ?? {};
    const ownerId = userForRequest(request)!.id;
    if (typeof projectId !== 'string' || !orm.select().from(schema.projects).where(and(eq(schema.projects.id, projectId), eq(schema.projects.ownerId, ownerId))).get()) return response.status(400).json({ error: 'Save the current project before importing an image.' });
    if (typeof pinId !== 'string' || !/^\d+$/.test(pinId)) return response.status(400).json({ error: 'Select a Pinterest search result to import.' });
    const pin = pinterestResults.get(pinId);
    if (!pin || pin.expiresAt < Date.now()) return response.status(400).json({ error: 'Run the Pinterest search again before importing this Pin.' });
    try {
      const result = await fetch(pin.imageUrl, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
      if (!result.ok || !result.body) return response.status(502).json({ error: 'Pinterest image download failed.' });
      const declaredSize = Number(result.headers.get('content-length'));
      if (declaredSize > 30 * 1024 * 1024) return response.status(413).json({ error: 'Pinterest image exceeds the 30 MB limit.' });
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of result.body) {
        const data = Buffer.from(chunk);
        total += data.length;
        if (total > 30 * 1024 * 1024) return response.status(413).json({ error: 'Pinterest image exceeds the 30 MB limit.' });
        chunks.push(data);
      }
      const imported = await storeImageAsset(projectId, ownerId, `${pin.title || `Pinterest-${pinId}`}.png`, Buffer.concat(chunks), { sourceName: pin.title || `Pinterest Pin ${pinId}`, sourceUrl: pin.sourceUrl });
      response.status(201).json(imported);
    } catch (error) {
      response.status(502).json({ error: error instanceof Error ? error.message : 'Pinterest image import failed.' });
    }
  });
  app.post('/api/print/png', async (request, response) => {
    const dataUrl = request.body?.dataUrl;
    const dpi = request.body?.dpi;
    if (typeof dataUrl !== 'string' || dataUrl.length > 100 * 1024 * 1024) return response.status(400).json({ error: 'A PNG artwork under 75 MB is required.' });
    const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!match) return response.status(400).json({ error: 'Profile embedding accepts PNG artwork.' });
    try {
      const output = await convertToSrgbPng(Buffer.from(match[1], 'base64'), Number(dpi));
      response.setHeader('content-type', 'image/png');
      response.setHeader('x-image-width', String(output.width));
      response.setHeader('x-image-height', String(output.height));
      response.setHeader('x-color-space', 'sRGB');
      response.setHeader('x-icc-profile-name', 'sRGB IEC61966-2.1');
      response.send(output.data);
    } catch (error) {
      response.status(422).json({ error: error instanceof Error ? error.message : 'PNG profile embedding failed.' });
    }
  });
  app.post('/api/print/jpeg', async (request, response) => {
    const dataUrl = request.body?.dataUrl;
    const dpi = request.body?.dpi;
    if (typeof dataUrl !== 'string' || dataUrl.length > 100 * 1024 * 1024) return response.status(400).json({ error: 'A raster artwork under 75 MB is required.' });
    const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!match) return response.status(400).json({ error: 'JPEG production export accepts PNG artwork.' });
    try {
      const output = await convertToSrgbJpeg(Buffer.from(match[1], 'base64'), Number(dpi));
      response.setHeader('content-type', 'image/jpeg');
      response.setHeader('x-image-width', String(output.width));
      response.setHeader('x-image-height', String(output.height));
      response.setHeader('x-color-space', 'sRGB');
      response.setHeader('x-icc-profile-name', 'sRGB IEC61966-2.1');
      response.send(output.data);
    } catch (error) {
      response.status(422).json({ error: error instanceof Error ? error.message : 'JPEG profile embedding failed.' });
    }
  });
  app.post('/api/print/cmyk', async (request, response) => {
    const dataUrl = request.body?.dataUrl;
    if (typeof dataUrl !== 'string' || dataUrl.length > 100 * 1024 * 1024) return response.status(400).json({ error: 'A raster image under 75 MB is required for CMYK conversion.' });
    const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!match) return response.status(400).json({ error: 'CMYK conversion accepts PNG or JPEG artwork.' });
    const input = Buffer.from(match[2], 'base64');
    if (!input.length || input.length > 75 * 1024 * 1024) return response.status(413).json({ error: 'Artwork exceeds the CMYK conversion size limit.' });
    try {
      const conversion = await convertToCmyk(input, Number(request.body?.dpi));
      cmykIccProfile = conversion.iccProfile;
      response.setHeader('content-type', 'image/jpeg');
      response.setHeader('x-image-width', String(conversion.width));
      response.setHeader('x-image-height', String(conversion.height));
      response.setHeader('x-color-space', 'CMYK');
      response.setHeader('x-icc-profile-name', 'Generic CMYK');
      response.send(conversion.data);
    } catch (error) {
      response.status(422).json({ error: error instanceof Error ? error.message : 'CMYK conversion failed.' });
    }
  });
  app.get('/api/print/icc/cmyk', async (_request, response) => {
    try {
      if (!cmykIccProfile) {
        const sample = await sharp({ create: { width: 1, height: 1, channels: 3, background: { r: 220, g: 220, b: 220 } } }).png().toBuffer();
        cmykIccProfile = (await convertToCmyk(sample, 300)).iccProfile;
      }
      response.setHeader('content-type', 'application/vnd.iccprofile');
      response.setHeader('x-icc-profile-name', 'Generic CMYK');
      response.send(cmykIccProfile);
    } catch (error) {
      response.status(503).json({ error: error instanceof Error ? error.message : 'The CMYK ICC profile is unavailable.' });
    }
  });
  app.get('/api/projects', (request, response) => response.json(allProjects(userForRequest(request)!.id)));
  app.post('/api/projects', (request, response) => {
    const project = parseProject(request.body);
    if (!project) return response.status(400).json({ error: 'Invalid project data' });
    try { response.status(201).json(writeProject(project, userForRequest(request)!.id)); } catch (error) { response.status(409).json({ error: error instanceof Error ? error.message : 'Unable to save project.' }); }
  });
  app.put('/api/projects/:id', (request, response) => {
    const project = parseProject(request.body);
    if (!project || project.id !== request.params.id) return response.status(400).json({ error: 'Invalid project data' });
    const userId = userForRequest(request)!.id;
    const current = orm.select({ content: schema.projects.content }).from(schema.projects).where(and(eq(schema.projects.id, request.params.id), eq(schema.projects.ownerId, userId))).get();
    if (!current && orm.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, request.params.id)).get()) return response.status(404).json({ error: 'Project not found in this account.' });
    if (current) {
      const saved = JSON.parse(current.content) as DesignProject;
      const incomingRevision = Date.parse(project.updatedAt ?? '');
      const savedRevision = Date.parse(saved.updatedAt ?? '');
      if (Number.isFinite(incomingRevision) && Number.isFinite(savedRevision) && incomingRevision <= savedRevision) return response.json(saved);
    }
    try { response.json(writeProject(project, userId)); } catch (error) { response.status(409).json({ error: error instanceof Error ? error.message : 'Unable to save project.' }); }
  });
  app.delete('/api/projects/:id', (request, response) => {
    const projectId = request.params.id;
    const userId = userForRequest(request)!.id;
    const existing = orm.select({ content: schema.projects.content }).from(schema.projects).where(and(eq(schema.projects.id, projectId), eq(schema.projects.ownerId, userId))).get();
    if (!existing) return response.status(404).json({ error: 'Project not found.' });
    const project = JSON.parse(existing.content) as DesignProject;
    if (!project.automationParentId || project.automationParentId !== request.body?.automationParentId) return response.status(403).json({ error: 'Only projects generated by this automation can be deleted this way.' });
    const otherProjects = orm.select({ id: schema.projects.id, content: schema.projects.content }).from(schema.projects).where(eq(schema.projects.ownerId, userId)).all().filter((item) => item.id !== projectId);
    const assets = orm.select().from(schema.assets).where(eq(schema.assets.projectId, projectId)).all();
    for (const asset of assets) {
      if (otherProjects.some((item) => item.content.includes(`/api/assets/${asset.id}`))) continue;
      const assetPath = path.resolve(asset.localPath);
      const expectedName = `${asset.id}.${path.extname(assetPath).slice(1)}`;
      if (path.dirname(assetPath) !== path.resolve(assetDirectory) || path.basename(assetPath) !== expectedName || !/^[a-f0-9-]{36}\.(?:png|jpg|jpeg|webp)$/i.test(expectedName)) continue;
      try {
        const stat = fs.lstatSync(assetPath);
        if (stat.isFile() || stat.isSymbolicLink()) fs.unlinkSync(assetPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    orm.delete(schema.projects).where(eq(schema.projects.id, projectId)).run();
    persist();
    response.status(204).end();
  });
  app.delete('/api/projects/:id/assets/prune', (request, response) => {
    const projectId = request.params.id;
    const projectExists = orm.select({ id: schema.projects.id }).from(schema.projects).where(and(eq(schema.projects.id, projectId), eq(schema.projects.ownerId, userForRequest(request)!.id))).get();
    const createdAfter = typeof request.body?.createdAfter === 'string' ? Date.parse(request.body.createdAfter) : NaN;
    if (!projectExists || !Number.isFinite(createdAfter) || createdAfter > Date.now() || createdAfter < Date.now() - 7 * 24 * 60 * 60 * 1000) return response.status(400).json({ error: 'A valid recent automation checkpoint is required.' });
    const projects = orm.select({ id: schema.projects.id, content: schema.projects.content }).from(schema.projects).where(eq(schema.projects.ownerId, userForRequest(request)!.id)).all();
    const candidates = orm.select().from(schema.assets).where(and(eq(schema.assets.projectId, projectId), eq(schema.assets.ownerId, userForRequest(request)!.id))).all().filter((asset) => Date.parse(asset.createdAt) >= createdAfter);
    let removed = 0;
    for (const asset of candidates) {
      if (projects.some((item) => item.content.includes(`/api/assets/${asset.id}`))) continue;
      const assetPath = path.resolve(asset.localPath);
      const expectedName = `${asset.id}.${path.extname(assetPath).slice(1)}`;
      if (path.dirname(assetPath) !== path.resolve(assetDirectory) || path.basename(assetPath) !== expectedName || !/^[a-f0-9-]{36}\.(?:png|jpg|jpeg|webp)$/i.test(expectedName)) continue;
      try {
        const stat = fs.lstatSync(assetPath);
        if (stat.isFile() || stat.isSymbolicLink()) fs.unlinkSync(assetPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      orm.delete(schema.assets).where(and(eq(schema.assets.id, asset.id), eq(schema.assets.ownerId, userForRequest(request)!.id))).run();
      removed += 1;
    }
    persist();
    response.json({ removed });
  });
  app.get('/api/product-templates', (request, response) => response.json(orm.select().from(schema.productTemplates).where(or(isNull(schema.productTemplates.ownerId), eq(schema.productTemplates.ownerId, userForRequest(request)!.id))).all().map((row) => JSON.parse(row.definition))));
  app.post('/api/product-templates', (request, response) => {
    const template = request.body;
    if (!template || typeof template.id !== 'string' || !/^custom-[a-z0-9-]{1,48}$/.test(template.id) || typeof template.name !== 'string' || !Number.isFinite(template.widthMm) || !Number.isFinite(template.heightMm) || !Array.isArray(template.regions) || template.regions.length > 16 || template.regions.some((region: Record<string, unknown>) => !region || typeof region.id !== 'string' || typeof region.name !== 'string' || ![region.x, region.y, region.width, region.height].every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1))) return response.status(400).json({ error: 'Invalid custom product template' });
    const ownerId = userForRequest(request)!.id;
    const existing = orm.select({ ownerId: schema.productTemplates.ownerId }).from(schema.productTemplates).where(eq(schema.productTemplates.id, template.id)).get();
    if (existing?.ownerId && existing.ownerId !== ownerId) return response.status(409).json({ error: 'This product template belongs to another account.' });
    const saved = { ...template, name: template.name.slice(0, 100), kind: 'custom', updatedAt: new Date().toISOString() };
    orm.insert(schema.productTemplates).values({ id: saved.id, name: saved.name, productType: 'custom', definition: json(saved), updatedAt: saved.updatedAt, ownerId }).onConflictDoUpdate({ target: schema.productTemplates.id, set: { name: saved.name, definition: json(saved), updatedAt: saved.updatedAt, ownerId } }).run();
    orm.delete(schema.printableRegions).where(eq(schema.printableRegions.templateId, saved.id)).run();
    if (saved.regions.length) orm.insert(schema.printableRegions).values(saved.regions.map((region: { id: string; name: string; x: number; y: number; width: number; height: number }) => ({ ...region, id: `${saved.id}-${region.id}`, templateId: saved.id }))).run();
    persist();
    response.status(201).json(saved);
  });
  app.post('/api/assets', (request, response) => {
    const { projectId, name, dataUrl, width, height, sourceUrl, sourceName } = request.body ?? {};
    if (typeof projectId !== 'string' || typeof name !== 'string' || typeof dataUrl !== 'string' || !Number.isFinite(width) || !Number.isFinite(height)) return response.status(400).json({ error: 'Invalid asset data' });
    const ownerId = userForRequest(request)!.id;
    const project = orm.select({ id: schema.projects.id }).from(schema.projects).where(and(eq(schema.projects.id, projectId), eq(schema.projects.ownerId, ownerId))).get();
    if (!project) return response.status(404).json({ error: 'Project not found. Create or reopen the project before importing assets.' });
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!match) return response.status(415).json({ error: 'Only PNG, JPEG, and WebP assets are supported' });
    const data = Buffer.from(match[2], 'base64');
    if (data.length > 30 * 1024 * 1024) return response.status(413).json({ error: 'Asset exceeds the 30 MB limit' });
    const id = crypto.randomUUID();
    const extension = match[1] === 'jpeg' ? 'jpg' : match[1];
    const localPath = path.join(assetDirectory, `${id}.${extension}`);
    fs.writeFileSync(localPath, data, { flag: 'wx' });
    const createdAt = new Date().toISOString();
    orm.insert(schema.assets).values({ id, projectId, localPath, mimeType: `image/${match[1]}`, sourceName: String(sourceName ?? name).slice(0, 240), sourceUrl: typeof sourceUrl === 'string' ? sourceUrl.slice(0, 1000) : null, width: Math.round(width), height: Math.round(height), createdAt, ownerId }).run();
    if (typeof sourceUrl === 'string' && sourceUrl.startsWith('https://')) orm.insert(schema.assetAttributions).values({ id: crypto.randomUUID(), assetId: id, sourceName: String(sourceName ?? name).slice(0, 240), sourceUrl: sourceUrl.slice(0, 1000), attributionText: 'Imported asset source', createdAt }).run();
    persist();
    response.status(201).json({ id, src: `/api/assets/${id}`, sourceName: String(sourceName ?? name), sourceUrl });
  });
  app.get('/api/assets/:id', (request, response) => {
    if (!/^[0-9a-f-]{36}$/i.test(request.params.id)) return response.status(404).end();
    const asset = orm.select().from(schema.assets).where(and(eq(schema.assets.id, request.params.id), eq(schema.assets.ownerId, userForRequest(request)!.id))).get();
    if (!asset) return response.status(404).end();
    response.type(asset.mimeType).send(fs.readFileSync(asset.localPath));
  });
  app.use(express.static(path.resolve(serverDirectory, '../dist')));
  app.get('*path', (_request, response) => response.sendFile(path.resolve(serverDirectory, '../dist/index.html')));
  app.listen(port, host, () => {
    const addresses = lanMode ? Object.values(os.networkInterfaces()).flatMap((entries) => (entries ?? []).filter((entry) => entry.family === 'IPv4' && !entry.internal).map((entry) => `http://${entry.address}:${port}`)) : [`http://127.0.0.1:${port}`];
    console.log(`AI Design Studio listening on ${host}:${port}`);
    for (const address of addresses) console.log(`Open on this network: ${address}`);
    if (setupToken) console.log(`One-time owner setup code: ${setupToken}`);
    void getLocalAIStatus(getLocalSettings()).then((status) => {
      console.log(`Ollama: ${status.ollamaAvailable ? status.selectedTextModelAvailable ? 'ready' : 'running; selected text model missing' : 'not running'}`);
      console.log(`ComfyUI: ${status.comfyAvailable ? status.selectedCheckpointAvailable ? 'ready' : 'running; select an installed checkpoint' : 'not running'}`);
    }).catch((error) => console.error('Local AI status check failed:', error instanceof Error ? error.message : error));
  });
}

start().catch((error) => {
  console.error('Unable to start local services', error);
  process.exit(1);
});
