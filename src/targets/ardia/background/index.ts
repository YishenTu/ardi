// Ardia's service worker. Pi drives Ardia itself, so the extension serves no
// browser requests.
import { startBackground } from "../../../background";
import target from "../target.json";

startBackground({ nativeHost: target.nativeHost });
