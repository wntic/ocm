// bun test only discovers files with .test/_test_/.spec/_spec_ in the name,
// while check.sh passes every test/*.mjs explicitly as filters — this file is
// the bridge that pulls the phase tests into discovery. Later phases append
// their imports here.
import "./phase01-loader.mjs"
import "./phase02-registry.mjs"
import "./phase03-materializer.mjs"
import "./phase04-precedence.mjs"
import "./phase05-install.mjs"
import "./phase06-manifests.mjs"
import "./phase07-trust.mjs"
import "./phase08-update.mjs"
import "./phase09-search.mjs"
import "./phase10a-core-mutations.mjs"
