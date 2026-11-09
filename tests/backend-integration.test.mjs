import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import initSqlJs from 'sql.js';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

test('local API preserves secret boundaries and reports unavailable authorized services', async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'iadesign-api-'));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let ownerCookie = '';
  const apiFetch = (input, init = {}) => fetch(input, { ...init, headers: { ...init.headers, ...(ownerCookie ? { cookie: ownerCookie } : {}) } });
  const serverFile = fileURLToPath(new URL('../electron/server.ts', import.meta.url));
  const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', serverFile], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DESIGN_STUDIO_DATA: dataDirectory },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { serverOutput += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { serverOutput += chunk; });
  try {
    let health;
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`API process exited (${child.exitCode}): ${serverOutput}`);
      try {
        health = await apiFetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) });
        if (health.ok) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(health?.status, 200, `API did not become healthy: ${serverOutput}`);

    assert.equal((await apiFetch(`${baseUrl}/api/projects`)).status, 401, 'Anonymous users must not read projects.');
    assert.equal((await apiFetch(`${baseUrl}/api/ai/settings`)).status, 401, 'Anonymous users must not read private AI settings.');
    const setupCode = serverOutput.match(/One-time owner setup code: ([a-f0-9]{12})/)?.[1];
    assert.ok(setupCode, `Owner setup code was not printed: ${serverOutput}`);
    const setupResponse = await apiFetch(`${baseUrl}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.test', password: 'owner-password-123', setupCode }) });
    assert.equal(setupResponse.status, 201);
    ownerCookie = setupResponse.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
    assert.match(ownerCookie, /^iadesign_session=/);
    assert.equal((await apiFetch(`${baseUrl}/api/projects`)).status, 200);

    const invalidCommonsSearch = await apiFetch(`${baseUrl}/api/commons/search?term=nike&category=other`);
    assert.equal(invalidCommonsSearch.status, 400);
    const invalidCommonsImport = await apiFetch(`${baseUrl}/api/commons/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'missing-project', imageId: '12345' }) });
    assert.equal(invalidCommonsImport.status, 400);

    const samplePng = await sharp({ create: { width: 8, height: 6, channels: 4, background: { r: 220, g: 80, b: 45, alpha: 1 } } }).png().toBuffer();
    let colorResponse;
    try {
      colorResponse = await apiFetch(`${baseUrl}/api/print/cmyk`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dataUrl: `data:image/png;base64,${samplePng.toString('base64')}`, dpi: 300 }),
      });
    } catch (error) {
      throw new Error(`CMYK route connection failed (API exit ${child.exitCode}; cause ${String(error)}; detail ${String(error?.cause)}; output ${serverOutput})`, { cause: error });
    }
    assert.equal(colorResponse.status, 200);
    assert.equal(colorResponse.headers.get('x-color-space'), 'CMYK');
    assert.equal(colorResponse.headers.get('x-icc-profile-name'), 'Generic CMYK');
    assert.ok(colorResponse.headers.get('x-icc-profile-name').length < 80);
    assert.equal(colorResponse.headers.get('content-type'), 'image/jpeg');
    const profileResponse = await apiFetch(`${baseUrl}/api/print/icc/cmyk`);
    assert.equal(profileResponse.status, 200);
    assert.equal(profileResponse.headers.get('content-type'), 'application/vnd.iccprofile');
    const profileBytes = Buffer.from(await profileResponse.arrayBuffer());
    assert.ok(profileBytes.length > 100_000, 'ICC profile bytes should be available outside HTTP headers');
    const jpegBytes = Buffer.from(await colorResponse.arrayBuffer());
    const convertedMetadata = await sharp(jpegBytes).metadata();
    assert.equal(convertedMetadata.space, 'cmyk');
    assert.deepEqual(convertedMetadata.icc, profileBytes);

    const settingsResponse = await apiFetch(`${baseUrl}/api/ai/settings`);
    const settings = await settingsResponse.json();
    assert.equal(settingsResponse.status, 200);
    assert.equal(settings.apiKeyConfigured, false);
    assert.equal(settings.mode, 'local');
    assert.equal('apiKey' in settings, false);

    const localSettingsResponse = await apiFetch(`${baseUrl}/api/ai/local/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ textModel: 'model-intentionally-not-installed', imageCheckpoint: '', mode: 'local' }),
    });
    assert.equal(localSettingsResponse.status, 200);
    const localSettings = await localSettingsResponse.json();
    assert.equal(localSettings.mode, 'local');
    assert.equal(localSettings.status.selectedTextModelAvailable, false);
    const localTextResponse = await apiFetch(`${baseUrl}/api/ai/local/text`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'marketing', prompt: 'Write a short product headline' }),
    });
    assert.equal(localTextResponse.status, 503);
    assert.match((await localTextResponse.json()).error, /not installed or Ollama is unavailable/i);

    const savedSettingsResponse = await apiFetch(`${baseUrl}/api/ai/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'https://provider.example/v1', textModel: 'text-test', imageModel: 'image-test', mode: 'provider' }),
    });
    assert.equal(savedSettingsResponse.status, 200);
    const savedSettings = await savedSettingsResponse.json();
    assert.equal(savedSettings.baseUrl, 'https://provider.example/v1');
    assert.equal(savedSettings.mode, 'provider');
    assert.equal(savedSettings.apiKeyConfigured, false);
    assert.equal('apiKey' in savedSettings, false);

    const textResponse = await apiFetch(`${baseUrl}/api/ai/text`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'marketing', prompt: 'Write a short product headline' }),
    });
    assert.equal(textResponse.status, 503);
    assert.match((await textResponse.json()).error, /API key/i);
    const posterPlanResponse = await apiFetch(`${baseUrl}/api/ai/text`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'poster-plan', prompt: 'Affiche de festival' }),
    });
    assert.equal(posterPlanResponse.status, 503);
    const invalidTextTask = await apiFetch(`${baseUrl}/api/ai/text`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'unknown', prompt: 'No request should be made' }),
    });
    assert.equal(invalidTextTask.status, 400);

    const projectResponse = await apiFetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'integration-project', name: 'Integration project', width: 100, height: 100, updatedAt: '2026-01-02T00:00:00.000Z', nodes: [] }),
    });
    assert.equal(projectResponse.status, 201);
    const freshProject = await apiFetch(`${baseUrl}/api/projects/integration-project`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'integration-project', name: 'Latest project', width: 100, height: 100, updatedAt: '2026-01-03T00:00:00.000Z', nodes: [] }),
    });
    assert.equal(freshProject.status, 200);
    const staleProject = await apiFetch(`${baseUrl}/api/projects/integration-project`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'integration-project', name: 'Stale project', width: 100, height: 100, updatedAt: '2026-01-02T12:00:00.000Z', nodes: [] }),
    });
    assert.equal(staleProject.status, 200);
    assert.equal((await staleProject.json()).name, 'Latest project', 'Older autosave requests must not overwrite a newer project revision.');
    const checkpointAt = new Date(Date.now() - 1000).toISOString();
    const stagedAssetResponse = await apiFetch(`${baseUrl}/api/assets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'integration-project', name: 'staged.png', dataUrl: `data:image/png;base64,${samplePng.toString('base64')}`, width: 8, height: 6 }),
    });
    assert.equal(stagedAssetResponse.status, 201);
    const stagedAsset = await stagedAssetResponse.json();
    const userResponse = await apiFetch(`${baseUrl}/api/auth/users`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'member@example.test', password: 'member-password-123' }) });
    assert.equal(userResponse.status, 201);
    const memberLoginResponse = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'member@example.test', password: 'member-password-123' }) });
    assert.equal(memberLoginResponse.status, 200);
    const memberCookie = memberLoginResponse.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
    assert.match(memberCookie, /^iadesign_session=/);
    const memberFetch = (input, init = {}) => fetch(input, { ...init, headers: { ...init.headers, cookie: memberCookie } });
    const memberProjects = await memberFetch(`${baseUrl}/api/projects`);
    assert.deepEqual(await memberProjects.json(), [], 'A new account must not see the owner’s projects.');
    assert.equal((await memberFetch(`${baseUrl}${stagedAsset.src}`)).status, 404, 'Assets must be private to their owner.');
    const crossAccountWrite = await memberFetch(`${baseUrl}/api/projects/integration-project`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'integration-project', name: 'stolen', width: 100, height: 100, nodes: [] }) });
    assert.equal(crossAccountWrite.status, 404, 'Another account must not overwrite a project.');
    assert.equal((await memberFetch(`${baseUrl}/api/auth/users`)).status, 403, 'Members must not manage accounts.');
    const imageProject = { id: 'integration-project', name: 'Latest project', width: 100, height: 100, updatedAt: new Date().toISOString(), nodes: [{ id: 'asset-reference', name: 'Asset', type: 'image', x: 0, y: 0, width: 8, height: 6, rotation: 0, fill: '#000000', visible: true, locked: false, opacity: 1, src: stagedAsset.src }] };
    const withAsset = await apiFetch(`${baseUrl}/api/projects/integration-project`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(imageProject) });
    assert.equal(withAsset.status, 200);
    const retainedAssets = await apiFetch(`${baseUrl}/api/projects/integration-project/assets/prune`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ createdAfter: checkpointAt }) });
    assert.equal((await retainedAssets.json()).removed, 0);
    assert.equal((await apiFetch(`${baseUrl}${stagedAsset.src}`)).status, 200, 'Assets referenced by a project must not be pruned.');
    const withoutAsset = await apiFetch(`${baseUrl}/api/projects/integration-project`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...imageProject, updatedAt: new Date(Date.now() + 1000).toISOString(), nodes: [] }) });
    assert.equal(withoutAsset.status, 200);
    const prunedAssets = await apiFetch(`${baseUrl}/api/projects/integration-project/assets/prune`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ createdAfter: checkpointAt }) });
    assert.equal((await prunedAssets.json()).removed, 1);
    assert.equal((await apiFetch(`${baseUrl}${stagedAsset.src}`)).status, 404);
    const generatedProject = await apiFetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'generated-project', automationParentId: 'integration-project', name: 'Generated project', width: 100, height: 100, updatedAt: new Date().toISOString(), nodes: [] }),
    });
    assert.equal(generatedProject.status, 201);
    const forbiddenDelete = await apiFetch(`${baseUrl}/api/projects/generated-project`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ automationParentId: 'other-project' }) });
    assert.equal(forbiddenDelete.status, 403);
    const removedGeneratedProject = await apiFetch(`${baseUrl}/api/projects/generated-project`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ automationParentId: 'integration-project' }) });
    assert.equal(removedGeneratedProject.status, 204);
    const projectListAfterDelete = await apiFetch(`${baseUrl}/api/projects`);
    assert.equal((await projectListAfterDelete.json()).some((item) => item.id === 'generated-project'), false);
    const imageResponse = await apiFetch(`${baseUrl}/api/ai/image`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'integration-project', task: 'generate', prompt: 'A simple test image' }),
    });
    assert.equal(imageResponse.status, 503);
    assert.match((await imageResponse.json()).error, /API key/i);

    const pinterestStatusResponse = await apiFetch(`${baseUrl}/api/pinterest/status`);
    const pinterestStatus = await pinterestStatusResponse.json();
    assert.equal(pinterestStatusResponse.status, 200);
    assert.equal(pinterestStatus.connected, false);
    assert.equal(pinterestStatus.clientSecretConfigured, false);

    const authorizeResponse = await apiFetch(`${baseUrl}/api/pinterest/authorize`, { method: 'POST' });
    assert.equal(authorizeResponse.status, 400);
    assert.match((await authorizeResponse.json()).error, /app ID and secret/i);

    const pinterestSearchResponse = await apiFetch(`${baseUrl}/api/pinterest/search?term=botanical`);
    assert.equal(pinterestSearchResponse.status, 503);
    assert.match((await pinterestSearchResponse.json()).error, /authorized Pinterest account/i);

    const callbackResponse = await apiFetch(`${baseUrl}/api/pinterest/callback?code=not-a-real-code&state=invalid`);
    assert.equal(callbackResponse.status, 400);
    console.log(JSON.stringify({ health: 'ok', settingsRedacted: true, imageAndTextMissingKey: '503 explicit', pinterestAuthorizationMissingCredentials: '400 explicit', unauthorizedSearch: '503 explicit', invalidOAuthState: '400 rejected' }));
  } finally {
    child.kill();
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test('private LAN setup enforces local origins and disables remote AI providers', async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'iadesign-lan-api-'));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverFile = fileURLToPath(new URL('../electron/server.ts', import.meta.url));
  const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', serverFile], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LAN_MODE: '1', DESIGN_STUDIO_DATA: dataDirectory },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { serverOutput += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { serverOutput += chunk; });
  try {
    let health;
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`API process exited (${child.exitCode}): ${serverOutput}`);
      try {
        health = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) });
        if (health.ok) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(health?.status, 200, `LAN API did not become healthy: ${serverOutput}`);
    const codeDeadline = Date.now() + 2_000;
    while (!/One-time owner setup code: [a-f0-9]{12}/.test(serverOutput) && Date.now() < codeDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
    const setupCode = serverOutput.match(/One-time owner setup code: ([a-f0-9]{12})/)?.[1];
    assert.ok(setupCode, `Owner setup code was not printed: ${serverOutput}`);
    const setupBody = JSON.stringify({ email: 'lan-owner@example.test', password: 'lan-owner-password-123', setupCode });
    assert.equal((await fetch(`${baseUrl}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: setupBody })).status, 403, 'Setup without an Origin must be rejected in LAN mode.');
    assert.equal((await fetch(`${baseUrl}/api/auth/setup`, { method: 'POST', headers: { origin: 'http://attacker.example', 'content-type': 'application/json' }, body: setupBody })).status, 403, 'Cross-origin setup must be rejected.');
    const setupResponse = await fetch(`${baseUrl}/api/auth/setup`, { method: 'POST', headers: { origin: baseUrl, 'content-type': 'application/json' }, body: setupBody });
    assert.equal(setupResponse.status, 201);
    const cookie = setupResponse.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
    const localFetch = (input, init = {}) => fetch(input, { ...init, headers: { ...init.headers, origin: baseUrl, cookie } });
    const aiSettings = await localFetch(`${baseUrl}/api/ai/settings`);
    assert.equal((await aiSettings.json()).remoteAIAllowed, false);
    const remoteSettings = await localFetch(`${baseUrl}/api/ai/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ baseUrl: 'https://provider.example/v1', textModel: 'remote-text', imageModel: 'remote-image', mode: 'provider' }) });
    assert.equal(remoteSettings.status, 403);
    const remoteText = await localFetch(`${baseUrl}/api/ai/text`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: 'marketing', prompt: 'private prompt' }) });
    assert.equal(remoteText.status, 403);
    const privateProjects = await localFetch(`${baseUrl}/api/projects`);
    assert.equal(privateProjects.status, 200);
    assert.equal(privateProjects.headers.get('cache-control'), 'no-store');
    await localFetch(`${baseUrl}/api/auth/logout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal((await fetch(`${baseUrl}/api/projects`)).status, 401, 'Signing out must invalidate the session.');
  } finally {
    child.kill();
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test('existing local data is backed up and assigned to the initial owner account', async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'iadesign-migration-'));
  const assetDirectory = path.join(dataDirectory, 'assets');
  await mkdir(assetDirectory, { recursive: true });
  const projectId = 'legacy-project';
  const assetId = '11111111-1111-4111-8111-111111111111';
  const project = { id: projectId, name: 'Legacy project', width: 320, height: 240, updatedAt: '2026-01-01T00:00:00.000Z', nodes: [] };
  const image = await sharp({ create: { width: 8, height: 6, channels: 4, background: { r: 80, g: 150, b: 210, alpha: 1 } } }).png().toBuffer();
  await writeFile(path.join(assetDirectory, `${assetId}.png`), image);
  const SQL = await initSqlJs({ locateFile: (file) => path.resolve('node_modules/sql.js/dist', file) });
  const legacyDatabase = new SQL.Database();
  legacyDatabase.run('CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT NOT NULL)');
  legacyDatabase.run('CREATE TABLE assets (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE, local_path TEXT NOT NULL, mime_type TEXT NOT NULL, source_name TEXT, source_url TEXT, width INTEGER NOT NULL, height INTEGER NOT NULL, created_at TEXT NOT NULL)');
  legacyDatabase.run('CREATE TABLE product_templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, product_type TEXT NOT NULL, definition TEXT NOT NULL, updated_at TEXT NOT NULL)');
  legacyDatabase.run('CREATE TABLE printable_regions (id TEXT PRIMARY KEY, template_id TEXT NOT NULL REFERENCES product_templates(id) ON DELETE CASCADE, name TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL, width REAL NOT NULL, height REAL NOT NULL)');
  legacyDatabase.run('INSERT INTO projects (id, name, content, updated_at) VALUES (?, ?, ?, ?)', [projectId, project.name, JSON.stringify(project), project.updatedAt]);
  legacyDatabase.run('INSERT INTO assets (id, project_id, local_path, mime_type, source_name, source_url, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [assetId, projectId, path.join(assetDirectory, `${assetId}.png`), 'image/png', 'legacy.png', null, 8, 6, project.updatedAt]);
  const template = { id: 'custom-legacy', name: 'Legacy custom', kind: 'custom', widthMm: 90, heightMm: 120, regions: [] };
  legacyDatabase.run('INSERT INTO product_templates (id, name, product_type, definition, updated_at) VALUES (?, ?, ?, ?, ?)', [template.id, template.name, 'custom', JSON.stringify(template), project.updatedAt]);
  await writeFile(path.join(dataDirectory, 'studio.sqlite'), Buffer.from(legacyDatabase.export()));
  legacyDatabase.close();
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverFile = fileURLToPath(new URL('../electron/server.ts', import.meta.url));
  const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', serverFile], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DESIGN_STUDIO_DATA: dataDirectory },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { serverOutput += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { serverOutput += chunk; });
  try {
    let health;
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`API process exited (${child.exitCode}): ${serverOutput}`);
      try {
        health = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) });
        if (health.ok) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(health?.status, 200, `Migrating API did not become healthy: ${serverOutput}`);
    const codeDeadline = Date.now() + 2_000;
    while (!/One-time owner setup code: [a-f0-9]{12}/.test(serverOutput) && Date.now() < codeDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
    const setupCode = serverOutput.match(/One-time owner setup code: ([a-f0-9]{12})/)?.[1];
    assert.ok(setupCode, `Owner setup code was not printed: ${serverOutput}`);
    const setupResponse = await fetch(`${baseUrl}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'migration-owner@example.test', password: 'migration-owner-password-123', setupCode }) });
    assert.equal(setupResponse.status, 201);
    const cookie = setupResponse.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
    const ownerFetch = (input) => fetch(input, { headers: { cookie } });
    const projects = await ownerFetch(`${baseUrl}/api/projects`).then((response) => response.json());
    assert.deepEqual(projects.map((item) => item.id), [projectId]);
    const importedAsset = await ownerFetch(`${baseUrl}/api/assets/${assetId}`);
    assert.equal(importedAsset.status, 200);
    assert.deepEqual(Buffer.from(await importedAsset.arrayBuffer()), image);
    const templates = await ownerFetch(`${baseUrl}/api/product-templates`).then((response) => response.json());
    assert.ok(templates.some((item) => item.id === template.id));
    const backup = new SQL.Database(await readFile(path.join(dataDirectory, 'studio.sqlite.pre-auth-migration.bak')));
    assert.equal(backup.exec('SELECT id FROM projects WHERE id = "legacy-project"')[0].values[0][0], projectId);
    assert.equal(backup.exec('SELECT id FROM assets WHERE id = "11111111-1111-4111-8111-111111111111"')[0].values[0][0], assetId);
    backup.close();
  } finally {
    child.kill();
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
