import { spawnSync } from 'node:child_process';
import { cwd } from 'node:process';
import { buildApiResult } from '../src/core/sessionApi.js';
import { resolveRepoPath } from '../src/core/path.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function runCli(args: string[]): unknown {
  const result = spawnSync(process.execPath, ['dist/cli.js', ...args], {
    cwd: cwd(),
    encoding: 'utf8',
  });
  assert(result.status === 0, `CLI failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

function assertApiShape(value: any): void {
  assert(value && typeof value === 'object', 'api-json must be an object');
  assert(value.filters && typeof value.filters === 'object', 'api-json filters missing');
  assert(value.summary && typeof value.summary === 'object', 'api-json summary missing');
  assert(Array.isArray(value.availableModels), 'api-json availableModels must be an array');
  assert(Array.isArray(value.projects), 'api-json projects must be an array');
}

function assertAgentShape(value: any): void {
  assert(value && typeof value === 'object', 'agent-json must be an object');
  assert(value.filters && typeof value.filters === 'object', 'agent-json filters missing');
  assert(value.summary && typeof value.summary === 'object', 'agent-json summary missing');
  assert(typeof value.summary.toolCalls === 'number', 'agent-json summary.toolCalls must be a number');
  assert(Array.isArray(value.projects), 'agent-json projects must be an array');
  for (const project of value.projects) {
    assert(typeof project.name === 'string', 'agent-json project.name must be a string');
    assert(typeof project.path === 'string', 'agent-json project.path must be a string');
    assert(Array.isArray(project.sessions), 'agent-json project.sessions must be an array');
    for (const session of project.sessions) {
      assert(typeof session.agent === 'string', 'agent-json session.agent must be a string');
      assert(typeof session.sessionId === 'string', 'agent-json session.sessionId must be a string');
      assert(Array.isArray(session.conversation), 'agent-json conversation must be an array');
      assert(Array.isArray(session.toolCalls), 'agent-json toolCalls must be an array');
    }
  }
}

async function main(): Promise<void> {
  const emptySince = '2099-01-01';
  const apiJson = runCli(['.', '--format', 'api-json', '--since', emptySince]);
  assertApiShape(apiJson);

  const direct = await buildApiResult([resolveRepoPath('.')], {
    agents: ['claude', 'codex', 'copilot'],
    roles: ['user', 'assistant', 'tool', 'system'],
    models: [],
    includeReasoning: true,
    firstPromptOnly: false,
    query: '',
    since: new Date(`${emptySince}T00:00:00.000`),
  });
  assert(JSON.stringify(apiJson) === JSON.stringify(direct), 'api-json CLI output must match buildApiResult output');

  const agentJson = runCli(['.', '--format', 'agent-json', '--since', emptySince, '--tool-output', 'none']);
  assertAgentShape(agentJson);

  const invalid = spawnSync(process.execPath, ['dist/cli.js', '.', '--format', 'bogus'], {
    cwd: cwd(),
    encoding: 'utf8',
  });
  assert(invalid.status === 2, 'invalid --format must exit with code 2');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
