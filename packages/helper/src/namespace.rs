//! Network and mount isolation through namespaces.
//!
//! A private network namespace is what closes the network: the command gets
//! nothing but loopback, so no TCP, no UDP and no datagrams leave the machine.
//! Name resolution still works though, because `nscd` and `systemd-resolved`
//! answer over a *unix socket*, and a unix socket is not scoped by a network
//! namespace. Those socket directories are therefore shadowed with an empty
//! tmpfs in a private mount namespace.
//!
//! The same mount namespace gives the command a private `/tmp`, which keeps
//! the scratch space from becoming a way to hand files to, or read files from,
//! other processes on the host.
//!
//! Everything is unprivileged: a new user namespace first (the only one an
//! unprivileged process may create), which grants the capabilities needed to
//! unshare the others.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

/// Directories that answer name lookups over a unix socket. Missing ones are
/// skipped: not every system runs both daemons, and a missing daemon leaks
/// nothing.
const RESOLVER_DIRS: [&str; 3] = ["/run/nscd", "/var/run/nscd", "/run/systemd/resolve"];

/// Where the private scratch space goes.
const PRIVATE_TMP: &str = "/tmp";

/// What the isolation actually achieved.
#[derive(Debug, Default)]
pub struct Isolated {
    /// Resolver socket directories that were shadowed.
    pub shadowed: Vec<PathBuf>,
}

/// Enter a fresh user namespace, then the mount namespace (and the network
/// namespace when the command must run offline).
pub fn isolate(offline: bool, cwd: Option<&Path>) -> Result<Isolated, String> {
    // The ids have to be read *before* unshare: inside a fresh user namespace
    // without a map, getuid() reports the overflow id (65534), and mapping that
    // is refused with EPERM.
    let ids = Ids::current();
    unshare(libc::CLONE_NEWUSER)?;
    write_uid_maps(ids)?;
    unshare(match offline {
        true => libc::CLONE_NEWNS | libc::CLONE_NEWNET,
        false => libc::CLONE_NEWNS,
    })?;
    // Without a private propagation, the mounts below would escape into the
    // host namespace on a system that mounts `/` shared.
    mount_none("/", libc::MS_REC | libc::MS_PRIVATE)?;

    // A private /tmp is skipped when the command works inside /tmp: the tmpfs
    // would hide the working directory. Landlock still limits what it can write.
    match cwd {
        Some(cwd) if cwd.starts_with(PRIVATE_TMP) => {}
        _ => {
            // A failure here is not fatal: the command keeps the host /tmp and
            // Landlock still limits what it may write.
            let _ = mount_tmpfs(Path::new(PRIVATE_TMP));
        }
    }

    let mut shadowed = Vec::new();
    if offline {
        for dir in resolver_dirs() {
            mount_tmpfs(&dir)?;
            shadowed.push(dir);
        }
    }
    Ok(Isolated { shadowed })
}

/// Resolver socket directories that exist on this host, canonicalised because
/// `/var/run` is usually a symlink to `/run`.
pub fn resolver_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    for candidate in RESOLVER_DIRS {
        let path = PathBuf::from(candidate);
        if path.exists() {
            let real = fs::canonicalize(&path).unwrap_or(path);
            if dirs.contains(&real) {
                // Already shadowed through another path.
            } else {
                dirs.push(real);
            }
        }
    }
    dirs
}

/// Whether this host lets an unprivileged process create a user namespace.
///
/// The only honest answer is to try it, which is why the probe runs in a
/// throwaway child process instead of the caller.
pub fn available() -> bool {
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    let status = std::process::Command::new(exe)
        .arg("--probe-userns")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    match status {
        Ok(status) => status.success(),
        Err(_) => false,
    }
}

/// `--probe-userns` mode: enter a user namespace and leave again.
pub fn probe() -> Result<(), String> {
    let ids = Ids::current();
    unshare(libc::CLONE_NEWUSER)?;
    write_uid_maps(ids)
}

fn unshare(flags: libc::c_int) -> Result<(), String> {
    let rc = unsafe { libc::unshare(flags) };
    if rc == 0 {
        return Ok(());
    }
    let err = std::io::Error::last_os_error();
    Err(format!("unshare({flags:#x}) failed: {err}"))
}

/// The ids to map inside the new user namespace, captured while the host ids
/// are still visible.
#[derive(Debug, Clone, Copy)]
struct Ids {
    uid: libc::uid_t,
    gid: libc::gid_t,
}

impl Ids {
    fn current() -> Self {
        Ids {
            uid: unsafe { libc::getuid() },
            gid: unsafe { libc::getgid() },
        }
    }
}

/// Map the current user to root inside the new user namespace, which is what
/// grants the capabilities needed to enter the other namespaces.
fn write_uid_maps(ids: Ids) -> Result<(), String> {
    let Ids { uid, gid } = ids;
    // setgroups must be denied before gid_map, otherwise the write is refused.
    match fs::write("/proc/self/setgroups", "deny") {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("cannot deny setgroups: {error}")),
    }?;
    fs::write("/proc/self/uid_map", format!("0 {uid} 1"))
        .map_err(|e| format!("cannot map uid {uid}: {e}"))?;
    fs::write("/proc/self/gid_map", format!("0 {gid} 1"))
        .map_err(|e| format!("cannot map gid {gid}: {e}"))
}

fn mount_none(target: &str, flags: libc::c_ulong) -> Result<(), String> {
    let rc = unsafe {
        libc::mount(
            std::ptr::null(),
            cstr(target).as_ptr(),
            std::ptr::null(),
            flags,
            std::ptr::null(),
        )
    };
    if rc == 0 {
        return Ok(());
    }
    Err(format!(
        "mount(NULL, {target}, MS_PRIVATE) failed: {}",
        std::io::Error::last_os_error()
    ))
}

fn mount_tmpfs(target: &Path) -> Result<(), String> {
    let source = std::ptr::null();
    let fstype = cstr("tmpfs");
    let data = cstr("mode=1777,size=512m");
    let flags = libc::MS_NOSUID | libc::MS_NODEV;
    let rc = unsafe {
        libc::mount(
            source,
            cstr(&target.to_string_lossy()).as_ptr(),
            fstype.as_ptr(),
            flags,
            data.as_ptr().cast(),
        )
    };
    if rc == 0 {
        return Ok(());
    }
    Err(format!(
        "cannot mount an empty tmpfs on {}: {}",
        target.display(),
        std::io::Error::last_os_error()
    ))
}

/// NUL-terminated bytes for a libc path argument.
fn cstr(text: &str) -> std::ffi::CString {
    match std::ffi::CString::new(text.as_bytes()) {
        Ok(value) => value,
        Err(_) => std::ffi::CString::new("").unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolver_dirs_are_absolute_and_deduplicated() {
        for dir in resolver_dirs() {
            assert!(dir.is_absolute(), "{dir:?} should be absolute");
        }
        let dirs = resolver_dirs();
        let mut unique = dirs.clone();
        unique.dedup();
        assert_eq!(dirs, unique, "duplicates should be collapsed");
    }

    #[test]
    fn cstr_never_panics_on_interior_nul() {
        assert_eq!(cstr("a\0b").to_string_lossy(), "");
        assert_eq!(cstr("/run/nscd").to_string_lossy(), "/run/nscd");
    }
}
