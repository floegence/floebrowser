import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function verifySecurity(commit, analyses, alerts) {
  assert.match(commit, /^[a-f0-9]{40}$/);
  for (const language of ['actions', 'go', 'javascript-typescript']) {
    const analysis = analyses.find(
      (entry) =>
        entry.commit_sha === commit &&
        entry.tool?.name === 'CodeQL' &&
        entry.category === `/language:${language}`,
    );
    assert.ok(analysis, `Missing CodeQL analysis for ${language} on ${commit}`);
    assert.equal(analysis.error, '', `CodeQL ${language} did not complete`);
    assert.ok(
      !analysis.warning,
      `CodeQL ${language} reported incomplete coverage`,
    );
  }
  for (const [kind, entries] of Object.entries(alerts))
    assert.equal(
      entries.length,
      0,
      `Unresolved ${kind} alerts: ${entries.map((entry) => entry.number).join(', ')}`,
    );
}

export function verifyDependencyRun(commit, runs) {
  const run = runs.find(
    (entry) =>
      entry.head_sha === commit &&
      entry.head_branch === 'main' &&
      entry.event === 'push',
  );
  assert.ok(run, `Missing dependency security run for ${commit}`);
  assert.equal(
    run.status,
    'completed',
    'Dependency security run is incomplete',
  );
  assert.equal(
    run.conclusion,
    'success',
    'Dependency security run did not pass',
  );
}

export function checkSecurity(commit, release = false) {
  const api = (path) =>
    JSON.parse(
      execFileSync(
        'gh',
        ['api', '--paginate', '--slurp', `repos/floegence/floebrowser/${path}`],
        { encoding: 'utf8' },
      ),
    ).flat();
  const [main] = api('commits/main');
  assert.equal(
    main.sha,
    commit,
    'Security qualification requires the current main commit',
  );
  const analyses = api(
    'code-scanning/analyses?ref=refs%2Fheads%2Fmain&per_page=100',
  );
  const endpoints = [
    [
      'code scanning',
      'code-scanning/alerts?ref=refs%2Fheads%2Fmain&state=open&per_page=100',
    ],
  ];
  // GitHub's workflow token cannot read secret-scanning or Dependabot alerts.
  // The maintainer check additionally audits those repository-wide findings;
  // publication requires the exact commit's executable dependency scan.
  if (!release)
    endpoints.push(
      ['dependency', 'dependabot/alerts?state=open&per_page=100'],
      ['secret', 'secret-scanning/alerts?state=open&per_page=100'],
    );
  const alerts = Object.fromEntries(
    endpoints.map(([kind, path]) => [kind, api(path)]),
  );
  verifySecurity(commit, analyses, alerts);
  const pages = api(
    `actions/workflows/dependency-security.yml/runs?head_sha=${commit}&event=push&per_page=100`,
  );
  verifyDependencyRun(
    commit,
    pages.flatMap((page) => page.workflow_runs),
  );
  console.log(
    `Security verified for ${commit}: three successful CodeQL languages, successful dependency scan; zero open ${Object.keys(alerts).join(', ')} alerts`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  checkSecurity(process.argv[2], process.argv[3] === '--release');
