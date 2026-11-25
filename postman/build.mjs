// Generates collection.json and environment.json: node postman/build.mjs
import fs from 'node:fs';

const test = (name, code) => `pm.test(${JSON.stringify(name)}, () => { ${code} });`;
const status = (code) => test(`status ${code}`, `pm.response.to.have.status(${code});`);
const problem = (code, type) => status(code) + test(`problem ${type}`, `pm.expect(pm.response.headers.get('Content-Type')).to.include('application/problem+json'); pm.expect(pm.response.json().type).to.match(/\\/${type}$/); pm.expect(pm.response.json().correlationId).to.eql(pm.response.headers.get('X-Correlation-Id'));`);
const set = (name, expr) => `pm.environment.set('${name}', ${expr});`;
const json = 'pm.response.json()';

const req = (name, method, url, tests, { token = 'sam', headers = {}, body, base = '{{baseUrl}}' } = {}) => ({
  name,
  event: [{ listen: 'test', script: { type: 'text/javascript', exec: [].concat(tests) } }],
  request: {
    method, url: base + url,
    header: [
      ...(token ? [{ key: 'Authorization', value: `Bearer {{${token}Token}}` }] : []),
      ...Object.entries(headers).map(([key, value]) => ({ key, value })),
      ...(body ? [{ key: 'Content-Type', value: 'application/json' }] : []),
    ],
    ...(body && { body: { mode: 'raw', raw: JSON.stringify(body) } }),
  },
});
const open = (base, body) => ({ token: null, base, body });
const login = (user, name) => req(`Sign in ${user}`, 'POST', '/dev/login', [status(200), set(`${name}Token`, `${json}.access_token`)], open('{{idpUrl}}', { user }));
const CASE = '/v1/cases/CS-10231';
const esc = { level: 'L2', reason: 'customer_impact', note: 'Escalated by the Postman run' };
const key = (n) => ({ 'Idempotency-Key': `pm-{{runId}}-${n}` });

const item = [
  { name: '0 Setup', item: [
    req('Reset mock data', 'POST', '/__reset', [status(200), set('runId', 'Date.now().toString()')], open('{{mockUrl}}')),
    login('sam.support', 'sam'), login('lena.lead', 'lena'), login('fiona.finance', 'fiona'), login('carl.csm', 'carl'),
    req('Agent: user signs in to the copilot', 'POST', '/dev/login', [status(200), set('subjectToken', `${json}.access_token`)], open('{{idpUrl}}', { user: 'sam.support', audience: 'support-copilot' })),
    req('Agent: token exchange', 'POST', '/token', [status(200), set('agentToken', `${json}.access_token`), test('no ARR scope', `pm.expect(${json}.scope).to.not.include('arr');`)],
      open('{{idpUrl}}', { grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', client_id: 'support-copilot-mcp', client_secret: '{{agentSecret}}', audience: 'entitlement-api', subject_token: '{{subjectToken}}' })),
  ] },
  { name: '1 Functional', item: [
    req('Health', 'GET', '/healthz', status(200), { token: null }),
    req('Customer, support view', 'GET', '/v1/customers/ACC-007', [status(200), test('no ARR', `pm.expect(${json}).to.not.have.property('arrUsd');`), test('rate limit headers', "pm.response.to.have.header('RateLimit-Remaining');")]),
    req('Customer, finance view', 'GET', '/v1/customers/ACC-007', [status(200), test('ARR', `pm.expect(${json}.arrUsd).to.eql(480000);`)], { token: 'fiona' }),
    req('Sample question', 'GET', '/v1/cases?supportTier=Platinum&priority=P1&openForMoreThanHours=48&renewalWithinDays=90&sort=renewalDate', [status(200), test('expected cases', `pm.expect(${json}.data.map(c => c.id)).to.eql(['CS-10231','CS-10260','CS-10240','CS-10275']);`)]),
    req('First page', 'GET', '/v1/cases?limit=5', [status(200), set('cursor', `encodeURIComponent(${json}.meta.nextCursor)`), set('firstIds', `JSON.stringify(${json}.data.map(c => c.id))`)]),
    req('Second page', 'GET', '/v1/cases?limit=5&cursor={{cursor}}', [status(200), test('no overlap', `const a = JSON.parse(pm.environment.get('firstIds')); ${json}.data.forEach(c => pm.expect(a).to.not.include(c.id));`)]),
    req('Add comment', 'POST', `${CASE}/comments`, [status(201), set('commentId', `${json}.id`)], { headers: key('c1'), body: { body: 'From Postman' } }),
    req('Add comment again: replay', 'POST', `${CASE}/comments`, [status(201), test('replayed', `pm.expect(pm.response.headers.get('Idempotent-Replayed')).to.eql('true'); pm.expect(${json}.id).to.eql(pm.environment.get('commentId'));`)], { headers: key('c1'), body: { body: 'From Postman' } }),
    req('Read case', 'GET', CASE, [status(200), set('etag', "pm.response.headers.get('ETag')"), test('one new comment', `pm.expect(${json}.commentCount).to.eql(2);`)]),
    req('Agent proposes an escalation', 'POST', `${CASE}/escalate`, [status(202), set('actionId', `${json}.id`)], { token: 'agent', headers: { ...key('e1'), 'If-Match': '{{etag}}' }, body: esc }),
    req('Person approves', 'POST', '/v1/action-requests/{{actionId}}/approve', [status(200), test('executed', `pm.expect(${json}.status).to.eql('executed');`)]),
    req('Case is escalated', 'GET', CASE, [status(200), test('L2', `pm.expect(${json}.escalation.level).to.eql('L2');`)]),
    req('Audit trail', 'GET', '/v1/audit-events?limit=20', [status(200), test('chain valid', `pm.expect(${json}.chainValid).to.eql(true);`)], { token: 'lena' }),
  ] },
  { name: '2 Regression', item: [
    req('No token', 'GET', '/v1/cases', problem(401, 'unauthorized'), { token: null }),
    req('Copilot token is refused by the API', 'GET', '/v1/cases', problem(401, 'unauthorized'), { token: 'subject' }),
    req('Unknown filter', 'GET', '/v1/cases?priorty=P1', problem(400, 'validation')),
    req('Forged cursor', 'GET', '/v1/cases?cursor=abc.def', problem(400, 'invalid-cursor')),
    req('ACC-77 is not a valid id', 'GET', '/v1/customers/ACC-77', problem(400, 'validation')),
    req('ACC-077 is another company', 'GET', '/v1/customers/ACC-077', [status(200), test('Zenith', `pm.expect(${json}.name).to.eql('Zenith Labs');`)]),
    req('Other account looks missing', 'GET', '/v1/customers/ACC-019', problem(404, 'not-found'), { token: 'carl' }),
    req('Agent of a user sees no ARR', 'GET', '/v1/customers/ACC-007', [status(200), test('redacted', `pm.expect(${json}.redactedFields).to.include('arrUsd');`)], { token: 'agent' }),
    req('Agent cannot approve', 'POST', '/v1/action-requests/{{actionId}}/approve', problem(403, 'agent-not-allowed'), { token: 'agent' }),
    req('Decided once', 'POST', '/v1/action-requests/{{actionId}}/approve', problem(409, 'already-decided')),
    req('Key reused with another body', 'POST', `${CASE}/comments`, problem(422, 'idempotency-mismatch'), { headers: key('c1'), body: { body: 'Different' } }),
    req('Comment without key', 'POST', `${CASE}/comments`, problem(400, 'validation'), { body: { body: 'x' } }),
    req('Finance cannot comment', 'POST', `${CASE}/comments`, problem(403, 'forbidden'), { token: 'fiona', headers: key('c2'), body: { body: 'x' } }),
    req('Escalate without If-Match', 'POST', `${CASE}/escalate`, problem(428, 'precondition-required'), { headers: key('e2'), body: { ...esc, level: 'L3' } }),
    req('Escalate with an old version', 'POST', `${CASE}/escalate`, problem(412, 'version-mismatch'), { headers: { ...key('e3'), 'If-Match': '"v1"' }, body: { ...esc, level: 'L3' } }),
    req('Escalate a P3', 'POST', '/v1/cases/CS-10291/escalate', [problem(409, 'escalation-rule'), test('rule', `pm.expect(${json}.rule).to.eql('priority');`)], { headers: { ...key('e4'), 'If-Match': '"v1"' }, body: esc }),
    req('Webhook to the metadata address', 'POST', '/v1/webhook-subscriptions', problem(422, 'target-not-allowed'), { token: 'lena', body: { url: 'https://169.254.169.254/x', events: ['case.escalated'] } }),
  ] },
  { name: '3 Degraded', item: [
    req('Break the warehouse', 'POST', '/__faults', status(200), open('{{mockUrl}}', { target: 'warehouse', mode: 'error' })),
    req('Customer still answers', 'GET', '/v1/customers/ACC-061', [status(200), test('degraded, entitlement present', `const b = ${json}; pm.expect(b.degraded).to.eql(true); pm.expect(b.supportTier).to.eql('Platinum');`)]),
    req('Repair the warehouse', 'POST', '/__faults', status(200), open('{{mockUrl}}', { target: 'warehouse', mode: 'off' })),
  ] },
];

const write = (file, data) => fs.writeFileSync(new URL(file, import.meta.url), `${JSON.stringify(data, null, 1)}\n`);
write('collection.json', {
  info: { name: 'Customer Entitlement & Support Case API', description: 'Run against `npm start`, folders in order.', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  item,
});
write('environment.json', {
  name: 'Local',
  values: [['baseUrl', 'http://localhost:4000'], ['idpUrl', 'http://localhost:4100'], ['mockUrl', 'http://localhost:4200'], ['agentSecret', 'local-agent-secret']].map(([k, value]) => ({ key: k, value, enabled: true })),
});
