package com.flowix.app

import android.app.Activity
import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.print.PageRange
import android.print.PrintAttributes
import android.print.PrintDocumentAdapter
import android.print.PrintManager
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStream
import java.util.concurrent.atomic.AtomicBoolean

@InvokeArg
class WriteTextArgs {
  lateinit var uri: String
  lateinit var content: String
}

@InvokeArg
class PrintDocumentArgs {
  var jobName: String? = null
}

/**
 * Export bridge for Android.
 *
 * The system save dialog (tauri-plugin-dialog) returns a `content://` URI and
 * creates the target document itself, so the Rust side cannot write it with
 * `std::fs`. Text exports are written here through a `ContentResolver`.
 *
 * PDF is different: Android only exposes the WebView -> PDF pipeline through
 * the print framework, and its `PrintDocumentAdapter` callbacks cannot be
 * constructed by apps (their constructors are package-private). The supported
 * path is therefore `PrintManager`, where the user picks "Save as PDF" and the
 * system spooler owns the destination document. The adapter below delegates to
 * the WebView adapter and keeps the IPC call pending until printing finishes,
 * so the web layer restores the print DOM only after the spooler is done.
 */
@TauriPlugin
class FlowixExportPlugin(private val activity: Activity) : Plugin(activity) {
  private var webView: WebView? = null

  override fun load(webView: WebView) {
    this.webView = webView
  }

  @Command
  fun writeTextToUri(invoke: Invoke) {
    val args = try {
      invoke.parseArgs(WriteTextArgs::class.java)
    } catch (error: Exception) {
      invoke.reject(error.message ?: "invalid export payload")
      return
    }

    // Content providers do disk I/O; keep it off the UI thread.
    Thread {
      try {
        openOutputStream(args.uri).use { output ->
          output.write(args.content.toByteArray(Charsets.UTF_8))
          output.flush()
        }
        invoke.resolve()
      } catch (error: Exception) {
        invoke.reject(error.message ?: "failed to write export file")
      }
    }.start()
  }

  @Command
  fun printDocument(invoke: Invoke) {
    val args = try {
      invoke.parseArgs(PrintDocumentArgs::class.java)
    } catch (error: Exception) {
      invoke.reject(error.message ?: "invalid print request")
      return
    }

    // The plugin normally receives the WebView through `load`; the activity
    // keeps a reference as well so a registration race cannot lose it.
    val view = webView ?: MainActivity.currentWebView
    if (view == null) {
      invoke.reject("document WebView is not ready")
      return
    }

    val jobName = args.jobName?.takeIf { it.isNotBlank() } ?: "Flowix"
    val settled = AtomicBoolean(false)
    fun finish(wrote: Boolean) {
      if (settled.compareAndSet(false, true)) {
        invoke.resolveObject(wrote)
      }
    }

    activity.runOnUiThread {
      val delegate = view.createPrintDocumentAdapter(jobName)
      val wrote = AtomicBoolean(false)

      // Forward the framework-provided callbacks to the WebView adapter. Apps
      // cannot instantiate LayoutResultCallback/WriteResultCallback, but the
      // print framework hands us instances through these overrides.
      val adapter = object : PrintDocumentAdapter() {
        override fun onStart() {
          delegate.onStart()
        }

        override fun onLayout(
          oldAttributes: PrintAttributes?,
          newAttributes: PrintAttributes?,
          cancellationSignal: android.os.CancellationSignal?,
          callback: LayoutResultCallback?,
          extras: Bundle?
        ) {
          delegate.onLayout(oldAttributes, newAttributes, cancellationSignal, callback, extras)
        }

        override fun onWrite(
          pages: Array<out PageRange>?,
          destination: android.os.ParcelFileDescriptor?,
          cancellationSignal: android.os.CancellationSignal?,
          callback: WriteResultCallback?
        ) {
          wrote.set(true)
          delegate.onWrite(pages, destination, cancellationSignal, callback)
        }

        override fun onFinish() {
          try {
            delegate.onFinish()
          } finally {
            finish(wrote.get())
          }
        }
      }

      val printManager = activity.getSystemService(Context.PRINT_SERVICE) as? PrintManager
      if (printManager == null) {
        invoke.reject("print service is unavailable")
        return@runOnUiThread
      }

      // A4 with page margins owned by the print stylesheet (@page margin),
      // matching the desktop exporters.
      val attributes = PrintAttributes.Builder()
        .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
        .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
        .setColorMode(PrintAttributes.COLOR_MODE_COLOR)
        .build()

      // `PrintDocumentAdapter.onFinish` is the normal completion signal; the
      // activity resume covers print services that never deliver it.
      MainActivity.pendingPrintCompletion = { finish(wrote.get()) }

      try {
        printManager.print(jobName, adapter, attributes)
      } catch (error: Exception) {
        MainActivity.pendingPrintCompletion = null
        if (settled.compareAndSet(false, true)) {
          invoke.reject(error.message ?: "failed to open the print dialog")
        }
      }
    }
  }

  private fun openOutputStream(uriText: String): OutputStream {
    val uri = Uri.parse(uriText)
    return when (uri.scheme) {
      ContentResolver.SCHEME_CONTENT -> activity.contentResolver.openOutputStream(uri, "wt")
        ?: throw IllegalStateException("cannot open export target")

      ContentResolver.SCHEME_FILE -> uri.path?.let { FileOutputStream(File(it)) }
        ?: throw IllegalArgumentException("invalid file URI")

      // Some providers hand back a plain path; keep the desktop code path
      // working when that happens.
      else -> FileOutputStream(File(uriText))
    }
  }
}
