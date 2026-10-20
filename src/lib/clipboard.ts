/**
 * 复制文本到剪贴板（带降级方案）。
 *
 * 为什么不能直接用 `navigator.clipboard.writeText`：
 * 该 API **只在安全上下文**（HTTPS 或 localhost）下可用。本部署是内网
 * http（如 http://172.29.57.34:3000），`navigator.clipboard` 为 `undefined`，
 * 直接调用会让整个事件处理器抛异常 —— 表现为「按钮点了没反应」。
 *
 * 因此先试现代 API，不可用（或失败）时退回到 `document.execCommand('copy')`
 * —— 这个老接口没有安全上下文限制，在 http 下仍可用。
 *
 * 返回是否成功，调用方据此给用户反馈（成功/失败都要有提示，否则用户无法
 * 判断到底复制没复制 —— 这正是之前的体验问题）。
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  // 1) 现代 API（同步、不闪选区）
  if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // 权限被拒或其它异常 —— 继续走降级方案
    }
  }

  // 2) 降级：临时 textarea + execCommand('copy')
  if (typeof document === "undefined") return false
  try {
    const ta = document.createElement("textarea")
    ta.value = text
    // 必须在视口内且可聚焦，否则部分浏览器选中失败；
    // 用 fixed + 透明隐藏而不是 display:none（后者不可选中）。
    ta.setAttribute("readonly", "")
    ta.style.position = "fixed"
    ta.style.top = "0"
    ta.style.left = "0"
    ta.style.width = "1px"
    ta.style.height = "1px"
    ta.style.padding = "0"
    ta.style.border = "none"
    ta.style.outline = "none"
    ta.style.boxShadow = "none"
    ta.style.background = "transparent"
    ta.style.opacity = "0"
    document.body.appendChild(ta)

    const selection = document.getSelection()
    const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null

    ta.select()
    ta.setSelectionRange(0, ta.value.length)

    let ok = false
    try {
      ok = document.execCommand("copy")
    } catch {
      ok = false
    }

    document.body.removeChild(ta)
    // 还原用户原本的选区，避免副作用
    if (previous && selection) {
      selection.removeAllRanges()
      selection.addRange(previous)
    }
    return ok
  } catch {
    return false
  }
}
