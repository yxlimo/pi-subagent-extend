//! `pi-subagent-extend-helper` — apply the pi-subagent-extend sandbox to one command.
//!
//! The pi extension rewrites a bash tool call into
//!
//! ```text
//! <helper> --spec <file> -- bash -lc '<command>'
//! ```
//!
//! and this binary sandboxes itself before handing the process over to that
//! command:
//!
//! * **files** — a Landlock ruleset (kernel ABI 7) allows reading the listed
//!   paths and writing only the writable ones;
//! * **network** — a private network namespace, so no TCP, no UDP and no DNS;
//! * **resolver** — the `nscd`/`systemd-resolved` socket directories are
//!   shadowed in the private mount namespace, because a unix socket crosses a
//!   network namespace;
//! * **processes** — a private PID namespace with a fresh `/proc`, so the host's
//!   processes and their environments are out of reach;
//! * **capabilities** — every capability is dropped before the command starts;
//! * **TCP** — also denied by Landlock, which keeps holding when the kernel
//!   refuses user namespaces.
//!
//! No system sandbox binary is involved: these are the same kernel primitives
//! bubblewrap is built from, applied by this process to itself.

mod namespace;
mod sandbox;
mod spec;
mod supervise;

use std::ffi::OsString;
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::process::Command;

use spec::Spec;

/// The kernel cannot sandbox this command: no Landlock, or an ABI below 7.
pub(crate) const EXIT_UNSUPPORTED: i32 = 76;
/// The spec handed over by the extension is unusable.
pub(crate) const EXIT_BAD_SPEC: i32 = 77;
/// The sandbox could not be set up, so the command must not run.
pub(crate) const EXIT_SANDBOX_FAILED: i32 = 78;
/// The command itself could not be executed.
const EXIT_EXEC_FAILED: i32 = 127;

const USAGE: &str = "\
usage:
  pi-subagent-extend-helper --describe
  pi-subagent-extend-helper [--spec <file|->] [--] <command> [args...]

  --describe       print the sandbox capabilities as JSON and exit
  --spec <file>    read the sandbox spec from <file>; '-' reads standard input
  --probe-userns   internal: report whether a user namespace can be created
  --version        print the helper version
";

fn main() {
    std::process::exit(run());
}

fn run() -> i32 {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    match args.first().and_then(|arg| arg.to_str()) {
        Some("--describe") => describe(),
        Some("--probe-userns") => match namespace::probe() {
            Ok(()) => 0,
            Err(error) => {
                eprintln!("pi-subagent-extend-helper: {error}");
                1
            }
        },
        Some("--version") | Some("-V") => {
            println!("pi-subagent-extend-helper {}", env!("CARGO_PKG_VERSION"));
            0
        }
        Some("--help") | Some("-h") | None => {
            print!("{USAGE}");
            0
        }
        Some("--spec") => match run_with_spec(&args[1..]) {
            Ok(code) => code,
            Err((code, message)) => {
                eprintln!("pi-subagent-extend-helper: {message}");
                code
            }
        },
        Some(other) => {
            eprintln!("pi-subagent-extend-helper: unknown option {other}\n\n{USAGE}");
            EXIT_BAD_SPEC
        }
    }
}

/// Everything after `--spec <where>`: the spec source, then the command.
fn run_with_spec(args: &[OsString]) -> Result<i32, (i32, String)> {
    let (source, rest) = args
        .split_first()
        .ok_or((EXIT_BAD_SPEC, "--spec needs a file or '-'".to_string()))?;
    let source = source.to_string_lossy().into_owned();
    let text = if source == "-" {
        let mut buffer = String::new();
        std::io::stdin().read_to_string(&mut buffer).map_err(|e| {
            (
                EXIT_BAD_SPEC,
                format!("cannot read the spec from stdin: {e}"),
            )
        })?;
        buffer
    } else {
        std::fs::read_to_string(&source)
            .map_err(|e| (EXIT_BAD_SPEC, format!("cannot read the spec {source}: {e}")))?
    };
    let spec = Spec::parse(&text).map_err(|e| (EXIT_BAD_SPEC, e))?;

    // An explicit `--` separates the spec from the command; without it the
    // first remaining argument is already the command.
    let command: &[OsString] = match rest.first().and_then(|arg| arg.to_str()) {
        Some("--") => &rest[1..],
        _ => rest,
    };
    let (program, program_args) = command
        .split_first()
        .ok_or((EXIT_BAD_SPEC, "no command given after the spec".to_string()))?;

    apply(program, program_args, &spec)
}

/// Enter the namespaces, then run the command inside the sandbox.
fn apply(program: &OsString, program_args: &[OsString], spec: &Spec) -> Result<i32, (i32, String)> {
    // The mount and PID namespaces always run: they are what give the command a
    // private /tmp and hide the host's processes. The network namespace is only
    // entered for an offline command.
    let cwd = spec.cwd.clone();
    match namespace::isolate(spec.offline, cwd.as_deref()) {
        Ok(isolated) => match isolated.shadowed.is_empty() {
            true => {}
            false => {
                let shadowed: Vec<String> = isolated
                    .shadowed
                    .iter()
                    .map(|dir| dir.display().to_string())
                    .collect();
                eprintln!(
                    "pi-subagent-extend-helper: network isolated, resolver sockets shadowed: {}",
                    shadowed.join(", ")
                );
            }
        },
        // Landlock still denies TCP below, so a host without user namespaces
        // loses the UDP/DNS cut, the private /tmp and the private /proc, but
        // not the sandbox as a whole. Staying quiet for an online command:
        // nothing was promised.
        Err(error) => {
            if spec.offline {
                eprintln!(
                    "pi-subagent-extend-helper: warning: cannot enter a network namespace ({error}); \
                     the command keeps host networking, only TCP stays blocked"
                );
            }
        }
    }

    supervise::run(|| run_command(program, program_args, spec))
        .map_err(|e| (EXIT_SANDBOX_FAILED, e))
}

/// Runs as the command, inside the PID namespace, and never returns on success.
fn run_command(program: &OsString, program_args: &[OsString], spec: &Spec) -> i32 {
    if let Some(cwd) = &spec.cwd {
        if let Err(error) = std::env::set_current_dir(cwd) {
            eprintln!(
                "pi-subagent-extend-helper: cannot enter {}: {error}",
                cwd.display()
            );
            return EXIT_SANDBOX_FAILED;
        }
    }

    if let Err(error) = sandbox::apply(spec) {
        eprintln!("pi-subagent-extend-helper: {error}");
        return EXIT_UNSUPPORTED;
    }
    // Nothing below needs a capability: the namespaces and mounts are set up,
    // and the sandbox itself is enforced by Landlock.
    if let Err(error) = namespace::drop_capabilities() {
        eprintln!("pi-subagent-extend-helper: {error}");
        return EXIT_SANDBOX_FAILED;
    }

    for (key, value) in &spec.env {
        std::env::set_var(key, value);
    }

    let error = Command::new(program).args(program_args).exec();
    let cwd = match &spec.cwd {
        Some(cwd) => cwd.display().to_string(),
        None => "the current directory".to_string(),
    };
    eprintln!(
        "pi-subagent-extend-helper: cannot execute {} in {cwd}: {error}",
        program.to_string_lossy()
    );
    EXIT_EXEC_FAILED
}

/// Print what this machine can enforce, as JSON, so the extension can gate on
/// it instead of guessing from the kernel version.
fn describe() -> i32 {
    let resolver: Vec<String> = namespace::resolver_dirs()
        .iter()
        .map(|dir| dir.display().to_string())
        .collect();
    let userns = namespace::available();
    let (supported, abi, reason) = match sandbox::abi_or_reason() {
        Ok(abi) => (true, abi, serde_json::Value::Null),
        Err(reason) => (false, 0, serde_json::Value::from(reason)),
    };
    let report = serde_json::json!({
        "helper": "pi-subagent-extend-helper",
        "version": env!("CARGO_PKG_VERSION"),
        "landlock": {
            "kernel_abi": abi,
            "required_abi": sandbox::REQUIRED_ABI,
            "supported": supported,
            "reason": reason,
        },
        "network_namespace": userns,
        "resolver_sockets": resolver,
    });
    println!("{report}");
    match supported {
        true => 0,
        false => EXIT_UNSUPPORTED,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_command_is_a_usage_error() {
        let args: Vec<OsString> = vec![OsString::from("/dev/null")];
        let error = run_with_spec(&args).expect_err("no command given");
        assert_eq!(error.0, EXIT_BAD_SPEC, "unexpected error: {}", error.1);
    }

    #[test]
    fn a_missing_spec_file_is_a_usage_error() {
        let args: Vec<OsString> = vec![
            OsString::from("/definitely/not/a/spec.json"),
            OsString::from("--"),
            OsString::from("true"),
        ];
        let error = run_with_spec(&args).expect_err("the spec cannot be read");
        assert_eq!(error.0, EXIT_BAD_SPEC, "unexpected error: {}", error.1);
    }
}
