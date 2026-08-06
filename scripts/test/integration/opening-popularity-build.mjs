import assert from 'node:assert/strict';
import { parseLinePopularityTsv } from '../../build-openings.mjs';

const fixture = `# source fixture
# snapshot fixture
uci\tglobalGames\tglobalShare
e2e4\t125000\t0.58
d2d4 d7d5\t42000\t0.41
broken\tnot-a-number\t0.2
`;

const parsed = parseLinePopularityTsv(fixture);
assert.deepEqual(parsed.get('e2e4'), {
  globalGames: 125000,
  globalShare: 0.58,
});
assert.deepEqual(parsed.get('d2d4 d7d5'), {
  globalGames: 42000,
  globalShare: 0.41,
});
assert.equal(parsed.has('broken'), false);
assert.equal(parsed.size, 2);

console.log('PASS: line-popularity snapshot fixture parsed and validated');
