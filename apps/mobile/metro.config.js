// Metro, configured for a pnpm workspace.
//
// pnpm does not hoist, so Metro has to be told two things it would otherwise
// discover by walking upwards: where the workspace packages live (watchFolders)
// and where to look for modules that are symlinked rather than copied
// (nodeModulesPaths). Without these, `@loom/core` resolves in TypeScript and
// then fails at runtime with an unhelpful bundler error.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
