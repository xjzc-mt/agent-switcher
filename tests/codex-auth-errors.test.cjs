const {test}=require('node:test');
const assert=require('node:assert/strict');
const {codexAuthFailure}=require('../dist/agents/codex');
test('OAuth refresh errors are recognized in messages and nested RPC details',()=>{
  for(const error of [
    {code:-32603,message:'refresh_token_invalidated; please sign in again'},
    {message:'Your refresh token has already been used to generate a new access token. Please sign in again.'},
    {message:'Your refresh token has been revoked. Please log in again.'},
    {message:'Your refresh token has expired.'},
    {message:'Request failed',data:{error:{code:'refresh_token_reused'}}},
    {message:'Request failed',data:{error:'invalid_grant'}},
    {message:'insufficient_user_authentication'},
    {data:{statusCode:401}}, {code:401}, {message:'HTTP status 401'},
  ])assert.ok(codexAuthFailure(error),JSON.stringify(error));
});
test('network, quota, permission and generic RPC errors are not labeled credential expiry',()=>{
  for(const error of [null,{},'Request 4012 failed',{code:-32603,message:'Internal error'},
    {message:'Failed to refresh token: connection timed out'},
    {status:429,message:'Rate limit exceeded'}, {status:503,message:'Service unavailable'},
    {status:403,message:'Insufficient permission for this resource'},
  ])assert.equal(codexAuthFailure(error),undefined,JSON.stringify(error));
});
