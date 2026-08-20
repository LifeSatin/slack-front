import test from 'node:test';import assert from 'node:assert/strict';import { normalizeSlackText,stableUuid } from '../src/utils.js';
test('stableUuid is deterministic and UUID shaped',()=>{const a=stableUuid('T:C:123');assert.equal(a,stableUuid('T:C:123'));assert.match(a,/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);});
test('normalizes Slack markup',()=>assert.equal(normalizeSlackText('<@U123> <#C1|general> <https://x.test|링크>'),'@U123 #general 링크 (https://x.test)'));
