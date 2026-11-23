# Contributing

Use Node.js 22.12+ and run `npm ci`, `npm test`, and `npm run build` before opening a pull request.

For a new decoder, include the function signature, expected arguments, and a test for the risk annotation. For real transaction fixtures, include the chain, Safe transaction hash, and execution transaction hash. Tests must work offline; mock requests for service integration tests.

Please omit private proposal data, RPC credentials, and wallet secrets from issues and fixtures.
