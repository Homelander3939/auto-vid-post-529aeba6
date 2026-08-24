const test = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULT_LOCAL_AGENT_SKILLS, normalizeAgentSkillRecord, parseSkillFiles } = require('../agentSkills');
const { tools, __test } = require('../ai-handler');

test('recovered skill rows without arrays normalize safely', () => {
  const skill = normalizeAgentSkillRecord({ id: 'old', key: 'recovered', status: 'pending' });
  assert.deepEqual(skill.triggers, []);
  assert.deepEqual(skill.steps, []);
  assert.deepEqual(skill.tags, []);
  assert.equal(skill.enabled, true);
});

test('imported prompt files stay guided and cannot install executable mappings', () => {
  const [skill] = parseSkillFiles([{
    path: 'skills/daily-check/SKILL.md',
    content: '---\nname: Daily Check\ntriggers: [check app, health]\n---\n# Daily Check\n- Inspect the queue\n- Report failures',
  }], 'local-test');
  assert.equal(skill.name, 'Daily Check');
  assert.equal(skill.execution, null);
  assert.equal(skill.risk_level, 'guided');
  assert.deepEqual(skill.triggers, ['check app', 'health']);
  assert.equal(skill.steps.length, 2);
});

test('built-in uploader skills use only existing allowlisted AI tools', () => {
  const allowed = new Set(tools.map((item) => item.function?.name));
  assert.equal(DEFAULT_LOCAL_AGENT_SKILLS.length, 7);
  for (const skill of DEFAULT_LOCAL_AGENT_SKILLS) {
    assert.ok(allowed.has(skill.execution.tool), `${skill.slug} references ${skill.execution.tool}`);
  }
  assert.ok(allowed.has('use_agent_skill'));
  assert.ok(allowed.has('run_local_browser'));
  assert.ok(allowed.has('run_technewslist_fallback'));
  const publisherFallback = DEFAULT_LOCAL_AGENT_SKILLS.find((skill) => skill.slug === 'technewslist-local-publisher-fallback');
  assert.equal(publisherFallback.execution.tool, 'run_technewslist_fallback');
  assert.deepEqual(publisherFallback.required_inputs, ['mode']);
  const browserSkill = DEFAULT_LOCAL_AGENT_SKILLS.find((skill) => skill.slug === 'local-browser-operator');
  assert.equal(browserSkill.execution.tool, 'run_local_browser');
  assert.deepEqual(browserSkill.required_inputs, ['task']);
  assert.equal(browserSkill.local_skill_version, 4);
  assert.ok(browserSkill.tags.includes('vision'));
  assert.ok(browserSkill.tags.includes('tool-calling'));
});

test('imported prompt descriptions expose quoted trigger phrases to the agent', () => {
  const [skill] = parseSkillFiles([{
    path: 'skill/pixelrag.md',
    content: '---\nname: PixelRAG\ndescription: Visual page retrieval. Triggers on: "index this screenshot", "search visual document"\n---\n# PixelRAG\nUse the local PixelRAG runtime when it is installed.',
  }], 'https://github.com/StarTrail-org/PixelRAG');
  assert.deepEqual(skill.triggers, ['index this screenshot', 'search visual document']);
  assert.equal(skill.execution, null);
  assert.equal(skill.source, 'imported-local');
});

test('saved skill tool results are compact enough for the loaded local context', () => {
  const long = Array.from({ length: 100 }, (_, index) => `VIDEO JOB QUEUE (${index})\n  job-${index} | partial\n  job-${index}-b | failed`).join('\n');
  const compact = __test.conciseSkillSummary(long, 1200);
  assert.ok(compact.length <= 1200);
  assert.match(compact, /Full verified output is saved/);
});

test('a completed saved skill can return directly without redundant inference', () => {
  const reply = __test.finalSkillToolReply(JSON.stringify({ ok: true, summary: 'Read-only health check completed.' }));
  assert.equal(reply, 'Read-only health check completed.');
});

test('explicit local browser skill requests route deterministically with task and URL', () => {
  const input = __test.explicitLocalBrowserSkillInput('Use local-browser-operator with task "Inspect the skills page" and url "http://127.0.0.1:8081/skills".');
  assert.deepEqual(input, { task: 'Inspect the skills page', url: 'http://127.0.0.1:8081/skills' });
  const typoInput = __test.explicitLocalBrowserSkillInput('use localc browser, go to example.com, log in and add a calendar event');
  assert.equal(typoInput?.url, 'https://example.com');
  assert.match(typoInput?.task || '', /localc browser/i);
  assert.equal(__test.explicitLocalBrowserSkillInput('What does the browser page do?'), null);
});

test('ordinary interactive website goals route to the browser without naming the skill', () => {
  const input = __test.explicitLocalBrowserSkillInput('Go to example.com and click Sign in.');
  assert.deepEqual(input, { task: 'Go to example.com and click Sign in.', url: 'https://example.com' });
  const factFinding = __test.explicitLocalBrowserSkillInput('Find the contact information on devsolabs.com and send it to me.');
  assert.deepEqual(factFinding, {
    task: 'Find the contact information on devsolabs.com and send it to me.',
    url: 'https://devsolabs.com',
  });
  assert.equal(__test.explicitLocalBrowserSkillInput('Explain what example domains are.'), null);
});
