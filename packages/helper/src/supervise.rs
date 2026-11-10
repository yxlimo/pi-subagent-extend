//! Process supervision for the PID namespace.
//!
//! Unsharing a PID namespace only takes effect for children, and the command
//! cannot be that first child: PID 1 of a namespace does not get default-action
//! signals, so `kill <helper>` would leave a shell that ignores SIGTERM.
//!
//! The tree is therefore three levels deep, the same shape bubblewrap uses:
//!
//! ```text
//! caller ── helper ──┬─ init   (PID 1 in the namespace, forwards signals)
//!                    │   └─ the command (PID 2+, replaced via execve)
//!                    └─ waits, mirrors the exit status
//! ```

use std::sync::atomic::{AtomicI32, Ordering};

/// Set by the supervisor once the command is running.
static COMMAND_PID: AtomicI32 = AtomicI32::new(0);

/// Run `child_main` as the sandboxed command and return its exit status.
///
/// `child_main` is expected to `exec`; returning from it means the command could
/// not be started, and the returned value becomes the exit status.
pub fn run(child_main: impl FnOnce() -> i32) -> Result<i32, String> {
    match unsafe { libc::fork() } {
        -1 => Err(format!(
            "cannot fork the sandbox init: {}",
            std::io::Error::last_os_error()
        )),
        0 => supervisor(child_main),
        pid => Ok(decode(wait_for(pid)?)),
    }
}

/// The PID 1 of the new namespace: mount a fresh procfs, then supervise.
fn supervisor(child_main: impl FnOnce() -> i32) -> ! {
    // If the caller dies, the whole namespace must die with it, otherwise the
    // command is orphaned inside a namespace nobody can reach.
    unsafe {
        libc::prctl(
            libc::PR_SET_PDEATHSIG,
            libc::SIGKILL as libc::c_ulong,
            0,
            0,
            0,
        )
    };

    if let Err(error) = crate::namespace::mount_proc() {
        eprintln!("pi-allow-reads-helper: {error}");
        unsafe { libc::_exit(crate::EXIT_SANDBOX_FAILED) }
    }

    // PID 1 only receives a signal when it has a handler installed, so the
    // default dispositions have to be replaced with forwarding ones.
    for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP, libc::SIGQUIT] {
        unsafe { libc::signal(signal, forward as *const () as libc::sighandler_t) };
    }

    match unsafe { libc::fork() } {
        -1 => {
            eprintln!(
                "pi-allow-reads-helper: cannot start the command: {}",
                std::io::Error::last_os_error()
            );
            unsafe { libc::_exit(crate::EXIT_SANDBOX_FAILED) }
        }
        0 => {
            let code = child_main();
            unsafe { libc::_exit(code) }
        }
        pid => {
            COMMAND_PID.store(pid, Ordering::SeqCst);
            let status = match wait_for(pid) {
                Ok(status) => status,
                Err(error) => {
                    eprintln!("pi-allow-reads-helper: {error}");
                    unsafe { libc::_exit(crate::EXIT_SANDBOX_FAILED) }
                }
            };
            unsafe { libc::_exit(decode(status)) }
        }
    }
}

/// Hand a signal that reached the supervisor to the command.
extern "C" fn forward(signal: libc::c_int) {
    let pid = COMMAND_PID.load(Ordering::SeqCst);
    if pid > 0 {
        unsafe { libc::kill(pid, signal) };
    }
}

/// Wait for one child, retrying across signal interruptions.
fn wait_for(pid: libc::pid_t) -> Result<libc::c_int, String> {
    let mut status: libc::c_int = 0;
    loop {
        let reaped = unsafe { libc::waitpid(pid, &mut status, 0) };
        if reaped == pid {
            return Ok(status);
        }
        if reaped < 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            return Err(format!("cannot wait for the command: {error}"));
        }
    }
}

/// Turn a `waitpid` status into the exit code the caller sees. A command killed
/// by signal N follows the shell convention of 128 + N.
fn decode(status: libc::c_int) -> i32 {
    if libc::WIFEXITED(status) {
        libc::WEXITSTATUS(status)
    } else if libc::WIFSIGNALED(status) {
        128 + libc::WTERMSIG(status)
    } else {
        crate::EXIT_SANDBOX_FAILED
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_exit_code_is_mirrored() {
        assert_eq!(decode(0), 0);
        // 0x0100 is the wait status of exit(1).
        assert_eq!(decode(0x0100), 1);
    }

    #[test]
    fn a_signal_death_becomes_128_plus_signal() {
        // SIGKILL (9) without the exited bit.
        assert_eq!(decode(9), 137);
    }
}
