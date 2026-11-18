//! Network, mount and PID isolation through namespaces.
//!
//! A private network namespace is what closes the network: the command gets
//! nothing but loopback, so no TCP, no UDP and no datagrams leave the machine.
//! Name resolution still works though, because `nscd` and `systemd-resolved`
//! answer over a *unix socket*, and a unix socket is not scoped by a network
//! namespace. Those socket directories are therefore shadowed with an empty
//! tmpfs in the private mount namespace.
//!
//! The mount namespace also gives the command a private scratch space, so
//! temporary files are not a way to hand files to, or read files from, other
//! processes. That tmpfs goes over the command's own temporary directory (the
//! spec's `tmp`) as well as the conventional `/tmp`, because the host's
//! `TMPDIR` is not always `/tmp`.
//!
//! A private PID namespace keeps the host's processes out of `/proc`; it only
//! takes effect for children, which is why [`crate::supervise`] forks.
//!
//! Everything is unprivileged: a new user namespace first (the only one an
//! unprivileged process may create), which grants the capabilities needed to
//! unshare the others. Those capabilities are dropped again before the command
//! starts, matching what bubblewrap does by default.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

/// Directories that answer name lookups over a unix socket. Missing ones are
/// skipped: not every system runs both daemons, and a missing daemon leaks
/// nothing.
const RESOLVER_DIRS: [&str; 3] = ["/run/nscd", "/var/run/nscd", "/run/systemd/resolve"];

/// The conventional scratch space, which the extension points its runtime and
/// state directories at. Every sandbox gets a private one.
const PRIVATE_TMP: &str = "/tmp";

/// The capability version the kernel expects: 3, i.e. two 32-bit words per set.
const LINUX_CAPABILITY_VERSION_3: u32 = 0x2008_0522;

/// `PR_CAP_AMBIENT_CLEAR_ALL` from `<linux/prctl.h>`; libc does not name it.
const PR_CAP_AMBIENT_CLEAR_ALL: libc::c_ulong = 4;

/// What the isolation actually achieved.
#[derive(Debug, Default)]
pub struct Isolated {
    /// Resolver socket directories that were shadowed.
    pub shadowed: Vec<PathBuf>,
    /// Directories that really got a private tmpfs. A mount that failed is not listed: the
    /// host directory is still visible there.
    pub privatised: Vec<PathBuf>,
}

/// Enter fresh user, mount, network and PID namespaces and set them up.
///
/// `tmp` is the temporary directory the command itself will use, as named by the
/// spec. The PID namespace only applies to children, so the caller must fork
/// afterwards (see [`crate::supervise`]).
pub fn isolate(offline: bool, cwd: Option<&Path>, tmp: Option<&Path>) -> Result<Isolated, String> {
    // The ids have to be read *before* unshare: inside a fresh user namespace
    // without a map, getuid() reports the overflow id (65534), and mapping that
    // is refused with EPERM.
    let ids = Ids::current();
    unshare(libc::CLONE_NEWUSER)?;
    write_uid_maps(ids)?;
    unshare(match offline {
        true => libc::CLONE_NEWNS | libc::CLONE_NEWNET | libc::CLONE_NEWPID,
        false => libc::CLONE_NEWNS | libc::CLONE_NEWPID,
    })?;
    // Without a private propagation, the mounts below would escape into the
    // host namespace on a system that mounts `/` shared.
    mount_none("/", libc::MS_REC | libc::MS_PRIVATE)?;

    let mut privatised = Vec::new();
    for dir in privatised_dirs(tmp, cwd) {
        // A failure here is not fatal: the command keeps the host directory and
        // Landlock still limits what it may write.
        if mount_tmpfs(&dir).is_ok() {
            // 只有挂载真的成立的目录才算被遮住：调用方据这份清单判断写授权是否失效，
            // 一次失败的挂载并不遮任何东西。
            privatised.push(dir);
        }
    }

    let mut shadowed = Vec::new();
    if offline {
        bring_up_loopback()?;
        for dir in resolver_dirs() {
            mount_tmpfs(&dir)?;
            shadowed.push(dir);
        }
    }
    Ok(Isolated {
        shadowed,
        privatised,
    })
}

/// The directories that get a private tmpfs: the conventional `/tmp` always,
/// plus the temporary directory the spec names unless it is that same path.
///
/// Both are needed. `/tmp` is where the extension points `XDG_RUNTIME_DIR` and
/// `MISE_STATE_DIR`, and where it tells a stuck agent to put its debug files;
/// the spec's directory is the one the command's own temp files land in. A host
/// whose `TMPDIR` is somewhere else used to get only the first, which left the
/// second writable through Landlock with no mount over it — the write landed on
/// the host, outside the sandbox.
pub fn private_tmp_dirs(tmp: Option<&Path>) -> Vec<PathBuf> {
    let conventional = PathBuf::from(PRIVATE_TMP);
    match tmp {
        Some(tmp) if *tmp != conventional => vec![conventional, tmp.to_path_buf()],
        _ => vec![conventional],
    }
}

/// The directories that actually get a private tmpfs: [`private_tmp_dirs`] minus the ones
/// holding the working directory, where the mount would hide the cwd instead.
///
/// `isolate` mounts exactly this list, so "what will be privatised" has one definition.
pub fn privatised_dirs(tmp: Option<&Path>, cwd: Option<&Path>) -> Vec<PathBuf> {
    private_tmp_dirs(tmp)
        .into_iter()
        .filter(|dir| should_private_tmp(dir, cwd))
        .collect()
}

/// Whether to put a fresh tmpfs over `dir`.
///
/// Skipped when the command works inside `dir`, including `dir` itself: the tmpfs
/// would hide the working directory and the command would fail before it started.
/// Skipped as well for a path with nothing sensible to mount on — not absolute,
/// or `/`, where the mount would hide the filesystem the sandbox reads through.
pub fn should_private_tmp(dir: &Path, cwd: Option<&Path>) -> bool {
    if !dir.is_absolute() || dir == Path::new("/") {
        return false;
    }
    !cwd.is_some_and(|cwd| cwd.starts_with(dir))
}

/// A write grant that a private tmpfs has hidden: the grant, and the directory mounted
/// over it.
///
/// A grant naming the privatised directory *itself* is fine — the mount point survives the
/// mount, so Landlock can still allow writes to the fresh tmpfs root, which is what the
/// extension's own `/tmp` entry does on every call. Only a grant strictly below it is
/// unreachable: the tmpfs starts empty, the path the rule would attach to no longer exists,
/// and the helper used to refuse the whole spec with "spec path ... does not exist" — a
/// message that reads like a typo in the spec instead of a grant and a mount cancelling out.
///
/// Both sides must already be comparable, i.e. resolved through
/// [`resolve_comparable`] — [`resolved_hidden_grant`] is the same check with that step
/// applied. The comparison itself is pure, so a unit test can pin it without a filesystem.
pub fn hidden_grant(grants: &[PathBuf], privatised: &[PathBuf]) -> Option<(PathBuf, PathBuf)> {
    for dir in privatised {
        for grant in grants {
            if grant != dir && grant.starts_with(dir) {
                return Some((grant.clone(), dir.clone()));
            }
        }
    }
    None
}

/// [`hidden_grant`] with both sides resolved through their symlinks, so a grant that
/// reaches a privatised directory through a link is caught too.
pub fn resolved_hidden_grant(
    grants: &[PathBuf],
    privatised: &[PathBuf],
) -> Option<(PathBuf, PathBuf)> {
    let dirs: Vec<PathBuf> = privatised
        .iter()
        .map(|dir| resolve_comparable(dir))
        .collect();
    let grants: Vec<PathBuf> = grants
        .iter()
        .map(|grant| resolve_comparable(grant))
        .collect();
    hidden_grant(&grants, &dirs)
}

/// `path` with every symlink in its existing prefix resolved.
///
/// `fs::canonicalize` alone is not enough: a write grant may name a directory the command
/// is going to create, and after the tmpfs is mounted the granted path is gone by
/// definition — the tail that does not exist is therefore kept as typed, and only the part
/// that does exist is resolved.
pub fn resolve_comparable(path: &Path) -> PathBuf {
    if let Ok(real) = fs::canonicalize(path) {
        return real;
    }
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut probe = path;
    while let Some(parent) = probe.parent() {
        match probe.file_name() {
            Some(name) => tail.push(name.to_os_string()),
            // A trailing `..`: nothing to resolve, keep the path as it is.
            None => return path.to_path_buf(),
        }
        if let Ok(real) = fs::canonicalize(parent) {
            let mut resolved = real;
            for name in tail.iter().rev() {
                resolved.push(name);
            }
            return resolved;
        }
        probe = parent;
    }
    path.to_path_buf()
}

/// Bring `lo` up inside the fresh network namespace.
///
/// A new netns starts with loopback administratively down, so `bind` succeeds
/// (it does not need the interface) while every connection to it fails with
/// `ENETUNREACH` — a test that starts a local server would still be unable to
/// talk to it. The namespace has no other interface and no route out, so
/// bringing loopback up does not make the command any less offline.
fn bring_up_loopback() -> Result<(), String> {
    /// `<linux/sockios.h>`
    const SIOCGIFFLAGS: libc::c_ulong = 0x8913;
    const SIOCSIFFLAGS: libc::c_ulong = 0x8914;

    let fd = unsafe { libc::socket(libc::AF_INET, libc::SOCK_DGRAM, 0) };
    if fd < 0 {
        return Err(format!(
            "cannot open a socket to configure lo: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: `ifreq` is plain old data; zeroing it is the documented way to
    // start, since the union has no default.
    let mut request: libc::ifreq = unsafe { std::mem::zeroed() };
    for (slot, byte) in request.ifr_name.iter_mut().zip(b"lo\0") {
        *slot = *byte as libc::c_char;
    }
    // SAFETY: fd is an open socket and request is a live, correctly sized ifreq.
    let read_flags = unsafe { libc::ioctl(fd, SIOCGIFFLAGS, &mut request) };
    if read_flags < 0 {
        let error = std::io::Error::last_os_error();
        unsafe { libc::close(fd) };
        return Err(format!("cannot read the flags of lo: {error}"));
    }
    // SAFETY: same request, now carrying the flags just read.
    unsafe {
        request.ifr_ifru.ifru_flags |= (libc::IFF_UP | libc::IFF_RUNNING) as libc::c_short;
    }
    // SAFETY: as above; SIOCSIFFLAGS writes the flags back.
    let write_flags = unsafe { libc::ioctl(fd, SIOCSIFFLAGS, &request) };
    let write_error = (write_flags < 0).then(std::io::Error::last_os_error);
    unsafe { libc::close(fd) };
    match write_error {
        Some(error) => Err(format!("cannot bring lo up: {error}")),
        None => Ok(()),
    }
}

/// Mount a fresh procfs, so `/proc` shows this PID namespace and not the host.
///
/// Must run inside the new PID namespace, i.e. in a child after
/// `unshare(CLONE_NEWPID)`; from the parent it would show the old one.
pub fn mount_proc() -> Result<(), String> {
    unmount_quietly("/proc");
    let flags = libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC;
    let rc = unsafe {
        libc::mount(
            cstr("proc").as_ptr(),
            cstr("/proc").as_ptr(),
            cstr("proc").as_ptr(),
            flags,
            std::ptr::null(),
        )
    };
    if rc == 0 {
        return Ok(());
    }
    Err(format!(
        "cannot mount a fresh /proc: {}",
        std::io::Error::last_os_error()
    ))
}

/// Drop every capability, the way bubblewrap does by default.
///
/// The bounding set goes first: a capability missing from it cannot come back
/// through `execve`, even from a file capability.
pub fn drop_capabilities() -> Result<(), String> {
    // Anything above the kernel's last capability is refused; the failures are
    // expected and carry no meaning.
    for cap in 0..=63u32 {
        unsafe { libc::prctl(libc::PR_CAPBSET_DROP, cap as libc::c_ulong, 0, 0, 0) };
    }
    unsafe { libc::prctl(libc::PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0) };

    let header = CapHeader {
        version: LINUX_CAPABILITY_VERSION_3,
        pid: 0,
    };
    let data = [CapData {
        effective: 0,
        permitted: 0,
        inheritable: 0,
    }; 2];
    let rc = unsafe { libc::syscall(libc::SYS_capset, &header, data.as_ptr()) };
    match rc {
        0 => Ok(()),
        _ => Err(format!(
            "cannot drop capabilities: {}",
            std::io::Error::last_os_error()
        )),
    }
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

/// The libc `capset` argument shape, spelled out because the libc crate does not
/// expose these two structures on Linux.
#[repr(C)]
struct CapHeader {
    version: u32,
    pid: libc::c_int,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CapData {
    effective: u32,
    permitted: u32,
    inheritable: u32,
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

/// Unmount whatever is already at `target` so a fresh filesystem can go there.
fn unmount_quietly(target: &str) {
    unsafe { libc::umount2(cstr(target).as_ptr(), libc::MNT_DETACH) };
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
    fn a_tmpdir_outside_tmp_is_privatized_too() {
        // The extension sends the directory the command's temp files land in. When
        // the host's TMPDIR is not /tmp, that directory has to be shadowed too:
        // granting it without a mount let the writes land on the host.
        let custom = Path::new("/var/tmp/pi-scratch");
        assert_eq!(
            private_tmp_dirs(Some(custom)),
            vec![PathBuf::from("/tmp"), custom.to_path_buf()],
            "both the conventional /tmp and the spec's directory"
        );
        assert_eq!(
            private_tmp_dirs(None),
            vec![PathBuf::from("/tmp")],
            "a spec without a tmp path gets /tmp only"
        );
        assert_eq!(
            private_tmp_dirs(Some(Path::new("/tmp"))),
            vec![PathBuf::from("/tmp")],
            "the same directory is not mounted twice"
        );
    }

    #[test]
    fn a_scratch_dir_holding_the_cwd_is_not_mounted_over() {
        let custom = Path::new("/var/tmp/pi-scratch");
        let elsewhere = Some(Path::new("/home/user/project"));
        assert!(should_private_tmp(Path::new("/tmp"), elsewhere));
        assert!(should_private_tmp(custom, elsewhere));
        // The cwd itself, and anything below it: the tmpfs would hide it.
        assert!(!should_private_tmp(custom, Some(custom)));
        assert!(!should_private_tmp(
            custom,
            Some(Path::new("/var/tmp/pi-scratch/work"))
        ));
        assert!(!should_private_tmp(
            Path::new("/tmp"),
            Some(Path::new("/tmp/work"))
        ));
        // Nothing sensible to mount on.
        assert!(!should_private_tmp(Path::new("/"), None));
        assert!(!should_private_tmp(Path::new("tmp"), None));
    }

    /// 挂私有 tmpfs 之后，落在它下面的写授权就没有对应的 inode 了。早先 helper 只会把整份
    /// spec 报成 `spec path ... does not exist`，看起来像路径写错；真正的原因是那份授权和
    /// 这次挂载互相抵消。这条用例钉住判定：只报「目录之下」的授权，目录本身照旧可用。
    #[test]
    fn a_grant_below_a_privatised_dir_is_hidden_but_the_dir_itself_is_not() {
        let tmp = PathBuf::from("/tmp");
        let dirs = std::slice::from_ref(&tmp);
        assert_eq!(
            hidden_grant(&[PathBuf::from("/tmp/pi-review-reports")], dirs),
            Some((PathBuf::from("/tmp/pi-review-reports"), tmp.clone())),
            "a grant below the mount point has nothing to attach to"
        );
        assert_eq!(
            hidden_grant(&[tmp.clone()], dirs),
            None,
            "the mount point survives the mount; the extension grants /tmp on every call"
        );
        assert_eq!(
            hidden_grant(&[PathBuf::from("/tmpfoo/build")], dirs),
            None,
            "a sibling that merely shares the prefix is not below it"
        );
        assert_eq!(
            hidden_grant(&[PathBuf::from("/work/src")], dirs),
            None,
            "a grant outside the privatised tree is unaffected"
        );
    }

    /// cwd 落在临时目录里时那个目录不挂（否则 tmpfs 会把工作目录一起遮住），于是那里的写授权
    /// 仍然有效。这是既有行为，判定不能把它变成拒绝。
    #[test]
    fn a_cwd_under_tmp_leaves_tmp_out_of_the_privatised_set() {
        assert_eq!(
            privatised_dirs(None, Some(Path::new("/home/user/project"))),
            vec![PathBuf::from("/tmp")],
            "the conventional /tmp is mounted when the cwd is elsewhere"
        );
        assert!(
            privatised_dirs(None, Some(Path::new("/tmp/work"))).is_empty(),
            "a cwd under /tmp keeps /tmp visible, so a grant below it still works"
        );
        assert_eq!(
            privatised_dirs(
                Some(Path::new("/var/tmp/pi-scratch")),
                Some(Path::new("/tmp/work"))
            ),
            vec![PathBuf::from("/var/tmp/pi-scratch")],
            "only the directory holding the cwd is skipped"
        );
    }

    /// 授权经符号链接落到被挂载的目录上时同样失效：Landlock 的规则落在解析后的 inode 上，
    /// 所以判定必须按解析后的路径比较，否则 `link -> /tmp` 这种授权会漏网。
    #[test]
    fn a_grant_reaching_the_privatised_dir_through_a_symlink_is_caught() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("hidden-grant-{}", std::process::id()));
        let link = root.join("link");
        let created =
            fs::create_dir_all(&root).is_ok() && std::os::unix::fs::symlink("/tmp", &link).is_ok();
        if !created {
            // 建不出链接的宿主上这条断言无从谈起，跳过而不是假装通过。
            let _ = fs::remove_dir_all(&root);
            return;
        }
        let hidden = resolved_hidden_grant(&[link.join("build")], &[PathBuf::from("/tmp")]);
        let _ = fs::remove_dir_all(&root);
        assert_eq!(
            hidden,
            Some((PathBuf::from("/tmp/build"), PathBuf::from("/tmp"))),
            "the grant reaches /tmp through the link"
        );
    }

    #[test]
    fn cstr_never_panics_on_interior_nul() {
        assert_eq!(cstr("a\0b").to_string_lossy(), "");
        assert_eq!(cstr("/run/nscd").to_string_lossy(), "/run/nscd");
    }
}
