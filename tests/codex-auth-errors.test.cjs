const {test}=require('node:test');
const assert=require('node:assert/strict');
const {codexAuthFailure}=require('../dist/agents/codex');
test('OAuth failures distinguish a spent refresh token from an access or transport error',()=>{
  for(const [error, reason] of [
    [{message:'Unauthorized',data:{error:{code:'refresh_token_reused'}}}, 'refresh-reused'],
    [{message:'Your refresh token has been revoked. Please log in again.'}, 'refresh-revoked'],
    [{message:'Your refresh token has expired.'}, 'refresh-expired'],
    [{data:{error:'invalid_grant'}}, 'refresh-invalid'],
    [{data:{statusCode:401}}, 'authentication-rejected'],
    [{message:'Failed to refresh token: connection timed out'}, undefined],
    [{message:'Request 4012 failed'}, undefined],
  ]) assert.equal(codexAuthFailure(error), reason, JSON.stringify(error));
});
