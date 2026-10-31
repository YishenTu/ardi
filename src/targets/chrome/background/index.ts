// Chrome's service worker. Pi's browser tools run here, through the
// extension's debugger API.
import { startBackground } from "../../../background";
import target from "../target.json";
import { connectBrowser } from "./browser";

startBackground({ nativeHost: target.nativeHost, connectBrowser });
