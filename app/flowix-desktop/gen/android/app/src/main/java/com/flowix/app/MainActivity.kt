package com.flowix.app

import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowInsets
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.WindowCompat

class MainActivity : TauriActivity() {
  /** 前端主题色 → 原生窗口背景 (状态栏 / 手势条区域由系统栏露出窗口背景)。 */
  inner class NativeThemeBridge {
    @JavascriptInterface
    fun setWindowBackground(hex: String) {
      android.util.Log.i("FlowixTheme", "setWindowBackground($hex)")
      runOnUiThread {
        val color = try {
          Color.parseColor(hex)
        } catch (_: IllegalArgumentException) {
          return@runOnUiThread
        }
        // content view 自身着色即可覆盖 insets padding 区域 (WebView 是其子 view)。
        findViewById<View>(android.R.id.content)?.setBackgroundColor(color)
        window?.decorView?.setBackgroundColor(color)
        // 深色背景配浅色状态栏图标, 反之亦然 (按相对亮度判断)。
        val luminance = (0.299 * Color.red(color) + 0.587 * Color.green(color) + 0.114 * Color.blue(color)) / 255.0
        val lightIcons = luminance < 0.5
        val decor = window?.decorView ?: return@runOnUiThread
        WindowCompat.getInsetsController(window, decor).apply {
          isAppearanceLightStatusBars = !lightIcons
          isAppearanceLightNavigationBars = !lightIcons
        }
      }
    }
  }

  /**
   * Wry 在创建 WebView 时回调此钩子 ── 这是唯一可靠的注入点:
   * Tauri 的 WebView 不在 `R.id.content` 子树里, 遍历视图树拿到的是 null。
   * 在页面加载前注入, 前端首次应用主题即可用。
   */
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    currentWebView = webView
    webView.addJavascriptInterface(NativeThemeBridge(), "FlowixNative")
    android.util.Log.i("FlowixTheme", "bridge injected via onWebViewCreate")
  }

  override fun onResume() {
    super.onResume()
    // The system print sheet is another activity. Its dismissal resumes this
    // one; if the print adapter never delivered `onFinish` (some OEM print
    // services drop it), the pending export still settles here.
    val pending = pendingPrintCompletion
    pendingPrintCompletion = null
    pending?.invoke()
  }

  companion object {
    /** Live document WebView, used by [FlowixExportPlugin] for PDF rendering. */
    @Volatile
    var currentWebView: WebView? = null

    /** Fallback completion for an export while the print sheet is open. */
    @Volatile
    var pendingPrintCompletion: (() -> Unit)? = null
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Edge-to-edge 下 WebView 铺满屏幕, 应用标题栏会顶进系统状态条, 顶部
    // 按钮无法点击。给 content view 加系统栏 inset padding, 让整个 WebView
    // 落在状态条与手势条/键盘之间 (含 IME: 编辑器随键盘收起抬升)。
    val content = findViewById<View>(android.R.id.content)
    content.setOnApplyWindowInsetsListener { view, insets ->
      val top: Int
      val bottom: Int
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        val bars = insets.getInsets(
          WindowInsets.Type.systemBars()
            or WindowInsets.Type.displayCutout()
            or WindowInsets.Type.ime()
        )
        top = bars.top
        bottom = bars.bottom
      } else {
        @Suppress("DEPRECATION")
        top = insets.systemWindowInsetTop
        @Suppress("DEPRECATION")
        bottom = insets.systemWindowInsetBottom
      }
      view.setPadding(0, top, 0, bottom)
      insets
    }
  }
}
