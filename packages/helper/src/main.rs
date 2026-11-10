//! `pi-allow-reads-helper` — apply the pi-allow-reads sandbox to one command.
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
//!   shadowed in a private mount namespace, because a unix socket crosses a
//!   network namespace;
//! * **TCP** — also denied by Landlock, which keeps holding when the kernel
//!   refuses user namespaces.
//!
//! No system sandbox binary is involved: these are the same kernel primitives
//! bubblewrap is built from, applied by this process to itself.

mod namespace;
mod sandbox;
mod spec;

use std::ffi::OsString;
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::process::Command;

use spec::Spec;

/// The kernel cannot sandbox this command: no Landlock, or an ABI below 7.
const EXIT_UNSUPPORTED: i32 = 76;
/// The spec handed over by the extension is unusable.
const EXIT_BAD_SPEC: i32 = 77;
/// The sandbox could not be set up, so the command must not run.
const EXIT_SANDBOX_FAILED: i32 = 78;
/// The command itself could not be executed.
const EXIT_EXEC_FAILED: i32 = 127;

const USAGE: &str = "\
usage:
  pi-allow-reads-helper --describe
  pi-allow-reads-helper [--spec <file|->] [--] <command> [args...]

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
                eprintln!("pi-allow-reads-helper: {error}");
                1
            }
        },
        Some("--version") | Some("-V") => {
            println!("pi-allow-reads-helper {}", env!("CARGO_PKG_VERSION"));
            0
        }
        Some("--help") | Some("-h") | None => {
            print!("{USAGE}");
            0
        }
        Some("--spec") => match run_with_spec(&args[1..]) {
            Ok(code) => code,
            Err((code, message)) => {
                eprintln!("pi-allow-reads-helper: {message}");
                code
            }
        },
        Some(other) => {
            eprintln!("pi-allow-reads-helper: unknown option {other}\n\n{USAGE}");
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

    apply(&spec)?;
    exec(program, program_args, &spec)
}

/// Enter the namespaces and the Landlock domain, then become the command.
fn apply(spec: &Spec) -> Result<(), (i32, String)> {
    // The mount namespace always runs: it is what gives the command a private
    // /tmp. The network namespace is only entered for an offline command.
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
                    "pi-allow-reads-helper: network isolated, resolver sockets shadowed: {}",
                    shadowed.join(", ")
                );
            }
        },
        // Landlock still denies TCP below, so a host without user namespaces
        // loses the UDP/DNS cut and the private /tmp, but not the sandbox as a
        // whole. Staying quiet for an online command: nothing was promised.
        Err(error) => match spec.offline {
            true => eprintln!(
                "pi-allow-reads-helper: warning: cannot enter a network namespace ({error}); \
                 the command keeps host networking, only TCP stays blocked"
            ),
            false => {}
        },
    }

    if let Some(cwd) = &spec.cwd {
        std::env::set_current_dir(cwd).map_err(|e| {
            (
                EXIT_SANDBOX_FAILED,
                format!("cannot enter {}: {e}", cwd.display()),
            )
        })?;
    }

    sandbox::apply(spec).map_err(|e| (EXIT_UNSUPPORTED, e))?;

    for (key, value) in &spec.env {
        std::env::set_var(key, value);
    }
    Ok(())
}

/// Hand the process over to the command, keeping the sandbox.
fn exec(program: &OsString, args: &[OsString], spec: &Spec) -> Result<i32, (i32, String)> {
    let error = Command::new(program).args(args).exec();
    let cwd = match &spec.cwd {
        Some(cwd) => cwd.display().to_string(),
        None => "the current directory".to_string(),
    };
    Err((
        EXIT_EXEC_FAILED,
        format!(
            "cannot execute {} in {cwd}: {error}",
            program.to_string_lossy()
        ),
    ))
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
        "helper": "pi-allow-reads-helper",
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
