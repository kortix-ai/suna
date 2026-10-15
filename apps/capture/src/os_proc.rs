//! Process hygiene for the always-on recorders: no console window for any
//! child process, below-normal CPU priority, and the OS calls that used to be
//! child processes (free disk space, "is this pid alive") on Windows.
//!
//! Windows talks to kernel32 directly, so it needs no optional dependency and
//! every build of every binary gets it. Elsewhere these are no-ops or the
//! existing Unix paths.

use std::path::Path;

/// `CREATE_NO_WINDOW`: a console child gets no console window.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Hide the console window of a child process on Windows. No-op elsewhere.
pub fn no_window(cmd: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(cmd, CREATE_NO_WINDOW);
    cmd
}

/// Run this process (and the children it starts afterwards, which inherit the
/// class) below normal priority on Windows, so the foreground app (a CAD
/// tool, a build) always wins the CPU. No-op elsewhere.
pub fn below_normal_priority() {
    #[cfg(windows)]
    unsafe {
        const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
        if win::SetPriorityClass(win::GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS) == 0 {
            tracing::warn!("SetPriorityClass(BELOW_NORMAL) failed");
        }
    }
}

/// Tie every process this one starts from now on to this process's life: on
/// Windows, put it in a job object that kills the whole job when its last
/// handle closes. The handle is never closed, so it closes when this process
/// exits, however it exits (a hard kill included), and takes the children
/// along. Children inherit the job. No-op elsewhere.
pub fn kill_children_on_exit() {
    #[cfg(windows)]
    unsafe {
        const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: i32 = 9;
        const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
        let job = win::CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
        if job.is_null() {
            tracing::warn!("CreateJobObject failed: children may outlive the service");
            return;
        }
        let mut info: win::JobExtendedLimits = std::mem::zeroed();
        info.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let set = win::SetInformationJobObject(
            job,
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
            (&info as *const win::JobExtendedLimits).cast(),
            std::mem::size_of::<win::JobExtendedLimits>() as u32,
        );
        if set == 0 || win::AssignProcessToJobObject(job, win::GetCurrentProcess()) == 0 {
            tracing::warn!(
                "job object setup failed ({}): children may outlive the service",
                win::GetLastError()
            );
            win::CloseHandle(job);
        }
        // On success the handle stays open for the life of the process.
    }
}

/// Windows: a new job object that kills its processes when its last handle
/// closes, with `process` in it. The caller keeps the handle: closing it (or
/// this process ending, however it ends) ends `process` and everything it
/// started. For a child in another session: one job holds processes of one
/// session only, so the machine service gives each session's child its own.
#[cfg(windows)]
pub fn kill_on_close_job(process: *mut std::ffi::c_void) -> Option<*mut std::ffi::c_void> {
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: i32 = 9;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
    unsafe {
        let job = win::CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
        if job.is_null() {
            return None;
        }
        let mut info: win::JobExtendedLimits = std::mem::zeroed();
        info.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = win::SetInformationJobObject(
            job,
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
            (&info as *const win::JobExtendedLimits).cast(),
            std::mem::size_of::<win::JobExtendedLimits>() as u32,
        ) != 0
            && win::AssignProcessToJobObject(job, process) != 0;
        if !ok {
            tracing::warn!("job object for a child failed ({})", win::GetLastError());
            win::CloseHandle(job);
            return None;
        }
        Some(job)
    }
}

/// Tie a child to this process on Linux: the kernel sends it SIGTERM when this
/// process dies, a hard kill included (`PR_SET_PDEATHSIG`). The signal follows
/// the thread that started the child, so call it only from a thread that lives
/// as long as the process. A child whose parent died before the call exits at
/// once. No-op elsewhere: Windows uses [`kill_children_on_exit`].
pub fn die_with_parent(cmd: &mut tokio::process::Command) -> &mut tokio::process::Command {
    #[cfg(target_os = "linux")]
    {
        extern "C" {
            fn prctl(option: i32, ...) -> i32;
            fn getppid() -> i32;
        }
        const PR_SET_PDEATHSIG: i32 = 1;
        const SIGTERM: i32 = 15;
        let parent = std::process::id() as i32;
        // SAFETY: the closure runs between fork and exec and calls only
        // async-signal-safe functions.
        unsafe {
            cmd.pre_exec(move || {
                if prctl(PR_SET_PDEATHSIG, SIGTERM) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if getppid() != parent {
                    return Err(std::io::Error::other(
                        "the parent exited before the child started",
                    ));
                }
                Ok(())
            });
        }
    }
    cmd
}

/// Free space for the volume holding `path`, in GB (1e9 bytes).
#[cfg(windows)]
pub fn free_disk_gb(path: &Path) -> Option<f64> {
    use std::os::windows::ffi::OsStrExt;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    let mut free: u64 = 0;
    let ok = unsafe {
        win::GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut free,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    (ok != 0).then(|| free as f64 / 1e9)
}

#[cfg(not(windows))]
pub fn free_disk_gb(path: &Path) -> Option<f64> {
    let out = std::process::Command::new("df")
        .arg("-k")
        .arg(path)
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().nth(1)?;
    let avail_kb: f64 = line.split_whitespace().nth(3)?.parse().ok()?;
    Some(avail_kb / 1024.0 / 1024.0)
}

/// The process `pid` is running.
#[cfg(windows)]
pub fn pid_alive(pid: u32) -> bool {
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const STILL_ACTIVE: u32 = 259;
    const ERROR_ACCESS_DENIED: u32 = 5;
    unsafe {
        let h = win::OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            // Another user's (or an elevated) process exists but cannot be opened.
            return win::GetLastError() == ERROR_ACCESS_DENIED;
        }
        let mut code: u32 = 0;
        let ok = win::GetExitCodeProcess(h, &mut code);
        win::CloseHandle(h);
        ok != 0 && code == STILL_ACTIVE
    }
}

#[cfg(unix)]
pub fn pid_alive(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(not(any(unix, windows)))]
pub fn pid_alive(_pid: u32) -> bool {
    true
}

#[cfg(windows)]
#[allow(non_snake_case)]
mod win {
    pub use super::job_layout::JobExtendedLimits;
    use std::ffi::c_void;
    #[link(name = "kernel32")]
    extern "system" {
        pub fn GetCurrentProcess() -> *mut c_void;
        pub fn SetPriorityClass(h: *mut c_void, class: u32) -> i32;
        pub fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        pub fn GetExitCodeProcess(h: *mut c_void, code: *mut u32) -> i32;
        pub fn CloseHandle(h: *mut c_void) -> i32;
        pub fn GetLastError() -> u32;
        pub fn CreateJobObjectW(attrs: *mut c_void, name: *const u16) -> *mut c_void;
        pub fn SetInformationJobObject(
            job: *mut c_void,
            class: i32,
            info: *const c_void,
            len: u32,
        ) -> i32;
        pub fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
        pub fn GetDiskFreeSpaceExW(
            dir: *const u16,
            free_to_caller: *mut u64,
            total: *mut u64,
            total_free: *mut u64,
        ) -> i32;
    }
}

#[cfg(windows)]
mod job_layout {
    /// JOBOBJECT_BASIC_LIMIT_INFORMATION.
    #[repr(C)]
    pub struct JobBasicLimits {
        pub per_process_user_time_limit: i64,
        pub per_job_user_time_limit: i64,
        pub limit_flags: u32,
        pub minimum_working_set_size: usize,
        pub maximum_working_set_size: usize,
        pub active_process_limit: u32,
        pub affinity: usize,
        pub priority_class: u32,
        pub scheduling_class: u32,
    }

    /// JOBOBJECT_EXTENDED_LIMIT_INFORMATION (IO_COUNTERS is six u64).
    #[repr(C)]
    pub struct JobExtendedLimits {
        pub basic: JobBasicLimits,
        pub io_info: [u64; 6],
        pub process_memory_limit: usize,
        pub job_memory_limit: usize,
        pub peak_process_memory_used: usize,
        pub peak_job_memory_used: usize,
    }

    // The Windows SDK sizes on x64: 64 and 144 bytes.
    #[cfg(target_pointer_width = "64")]
    const _: () = assert!(
        std::mem::size_of::<JobBasicLimits>() == 64
            && std::mem::size_of::<JobExtendedLimits>() == 144
    );
}

#[cfg(test)]
mod tests {
    // A child started through `die_with_parent` dies when its parent is killed.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_child_dies_with_its_parent() {
        let exe = std::env::current_exe().unwrap();
        if std::env::var("PDEATH_ROLE").as_deref() == Ok("parent") {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async {
                let mut cmd = tokio::process::Command::new("sleep");
                cmd.arg("60");
                super::die_with_parent(&mut cmd);
                let child = cmd.spawn().unwrap();
                println!("CHILD {}", child.id().unwrap());
                std::mem::forget(child);
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            });
            return;
        }
        let mut parent = std::process::Command::new(exe)
            .args([
                "--exact",
                "os_proc::tests::the_child_dies_with_its_parent",
                "--nocapture",
            ])
            .env("PDEATH_ROLE", "parent")
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        use std::io::BufRead;
        let out = std::io::BufReader::new(parent.stdout.take().unwrap());
        let pid: u32 = out
            .lines()
            .map(|l| l.unwrap())
            .find_map(|l| l.strip_prefix("CHILD ").map(|p| p.parse().unwrap()))
            .unwrap();
        assert!(std::path::Path::new(&format!("/proc/{pid}")).exists());
        parent.kill().unwrap(); // SIGKILL
        parent.wait().unwrap();
        std::thread::sleep(std::time::Duration::from_secs(1));
        let state = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap_or_default();
        assert!(
            state.is_empty() || state.contains(") Z "),
            "child {pid} outlived its parent: {state}"
        );
    }

    #[test]
    fn this_process_is_alive_and_a_free_disk_is_measured() {
        assert!(super::pid_alive(std::process::id()));
        let gb = super::free_disk_gb(&std::env::temp_dir()).unwrap();
        assert!(gb > 0.0);
        super::below_normal_priority();
        let mut cmd = std::process::Command::new("true");
        super::no_window(&mut cmd);
    }
}
