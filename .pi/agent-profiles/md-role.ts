// Generic loader for role mds that carry their own `extend:` block.
//
// The extension must be loaded inside the child before any policy can exist, but this
// loader deliberately passes no profile name: the bindings file is not consulted at all,
// and the policy comes solely from the role md that `.pi/agents/<role>.md` declares in
// its `extend:` block.
//
// The path must be absolute: Node does not expand `~` in an import specifier.
import { activate } from "/home/shay/extensions/pi-subagents-extend/packages/pi-plugin/src/index.ts";

export default activate;
