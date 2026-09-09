// bun test only discovers files with .test/_test_/.spec/_spec_ in the name,
// while check.sh passes every test/*.mjs explicitly as filters — this file is
// the bridge that pulls the phase tests into discovery. Later phases append
// their imports here.
import "./phase01-loader.mjs"
import "./phase02-registry.mjs"
