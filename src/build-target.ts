// Replaced by both bundlers. Source execution defaults to Ardia; tests set
// the constant explicitly when exercising the Chrome transport.
declare const __ARDI_TARGET__: "ardia" | "chrome";
export const BUILD_TARGET = typeof __ARDI_TARGET__ === "undefined" ? "ardia" : __ARDI_TARGET__;
export const NATIVE_HOST = BUILD_TARGET === "chrome" ? "com.ardi.chrome.pi" : "com.ardi.pi";
