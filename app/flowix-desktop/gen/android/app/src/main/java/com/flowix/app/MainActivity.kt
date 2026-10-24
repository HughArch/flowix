package com.flowix.app

import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowInsets
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
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
