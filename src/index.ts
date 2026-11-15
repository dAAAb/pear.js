/**
 * pear.js: PEAR's robot station in TypeScript.
 *
 *   protocol   the texts a PEAR model reads and the action it writes
 *   agent      the model client (an OpenAI-compatible service, streamed) and the turn loop
*   console    PEAR's operator console: the console itself, its Home review and lease, and the task run
 *   station    the station's joint layer: configuration, limits, safety monitors
 *   so101      the SO-101 arm: joint layout and default settings, kinematics, servo layer, feedforward
 *   feetech    the Feetech STS3215 serial protocol and bus, over an abstract transport
 *   ruckig     the trajectory generator PEAR's station uses (a port of Ruckig, community edition)
 *   python     what every module shares of Python itself: its exceptions under their names, how it writes a value
 */
export * as agent from "./agent/index";
export * as console from "./console/index";
export * as feetech from "./feetech/index";
export * as protocol from "./protocol/index";
export * as python from "./python/index";
export * as ruckig from "./ruckig/index";
export * as so101 from "./so101/index";
export * as station from "./station/index";

/**
 * The commit of PEAR (https://github.com/mit-han-lab/pear) that every module here ports and is tested against.
 * A module is changed to follow a newer PEAR only together with its fixtures (tools/fixtures).
 */
export const PEAR_COMMIT = "f32aa1f7c2ec9c3f45630cc9f8541b3201e8e087";
