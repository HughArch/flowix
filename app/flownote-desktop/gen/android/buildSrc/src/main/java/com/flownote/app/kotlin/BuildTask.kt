import java.io.File
import org.apache.tools.ant.taskdefs.condition.Os
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.logging.LogLevel
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.TaskAction

open class BuildTask : DefaultTask() {
    @Input
    var rootDirRel: String? = null
    @Input
    var target: String? = null
    @Input
    var release: Boolean? = null

    @TaskAction
    fun assemble() {
        val executable = if (Os.isFamily(Os.FAMILY_WINDOWS)) resolveWindowsNpm() else """npm"""
        runTauriCli(executable)
    }

    // Windows 下 gradle 原生进程启动器的 PATH 探测可能找不到 npm (nvm4w/fnm 等
    // 多版本管理器场景), 且 CreateProcessW 不能直接执行批处理文件。这里在任务
    // 执行时解析 PATH 得到 npm.cmd 绝对路径, 并经 `cmd /c` 启动。
    // 注意: gen/ 为本地生成物, 重新 `tauri android init` 后需重打此补丁。
    fun resolveWindowsNpm(): String {
        val pathDirs = System.getenv("PATH")?.split(';') ?: emptyList()
        for (dir in pathDirs) {
            if (dir.isBlank()) continue
            val candidate = File(dir.trim('"', ' '), "npm.cmd")
            if (candidate.isFile) return candidate.absolutePath
        }
        return "npm.cmd"
    }

    fun runTauriCli(executable: String) {
        val rootDirRel = rootDirRel ?: throw GradleException("rootDirRel cannot be null")
        val target = target ?: throw GradleException("target cannot be null")
        val release = release ?: throw GradleException("release cannot be null")
        val args = listOf("run", "--", "tauri", "android", "android-studio-script");

        project.exec {
            workingDir(File(project.projectDir, rootDirRel))
            if (Os.isFamily(Os.FAMILY_WINDOWS)) {
                executable("cmd")
                args("/c", executable)
            } else {
                executable(executable)
            }
            args(args)
            if (project.logger.isEnabled(LogLevel.DEBUG)) {
                args("-vv")
            } else if (project.logger.isEnabled(LogLevel.INFO)) {
                args("-v")
            }
            if (release) {
                args("--release")
            }
            args(listOf("--target", target))
        }.assertNormalExitValue()
    }
}
