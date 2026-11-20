// Simulate the identity claims carried by a bearer accepted by the fixture quota service.
exports.accessToken = (workspace, sub, email, generation, exp) => {
  const claims = { sub, jti: generation, exp, 'https://api.openai.com/profile': { email },
    'https://api.openai.com/auth': { chatgpt_account_id: workspace } };
  return 'h.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.s';
};
