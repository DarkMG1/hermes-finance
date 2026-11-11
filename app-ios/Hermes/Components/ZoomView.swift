import SwiftUI

/// Pinch to zoom up to 5×, two fingers to move (one finger stays with the content, such as drawing on it) unless `oneFingerPan`.
/// Back to 1× on a new `page`.
struct ZoomView<Content: View>: UIViewRepresentable {
    let page: Int
    var oneFingerPan = false
    @ViewBuilder let content: Content

    final class Scroll: UIScrollView, UIScrollViewDelegate {
        let host: UIHostingController<Content>
        var page = 0

        init(content: Content) {
            host = UIHostingController(rootView: content)
            super.init(frame: .zero)
            host.view.backgroundColor = .clear
            // the scroll view is already inside the safe area; insets here would shift the page off its boxes
            host.safeAreaRegions = []
            addSubview(host.view)
            delegate = self
            minimumZoomScale = 1
            maximumZoomScale = 5
            showsHorizontalScrollIndicator = false
            showsVerticalScrollIndicator = false
        }

        @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

        override func layoutSubviews() {
            super.layoutSubviews()
            // at 1× the page fills the view; zooming scales it from there
            if zoomScale == 1, host.view.frame.size != bounds.size {
                host.view.frame = CGRect(origin: .zero, size: bounds.size)
                contentSize = bounds.size
            }
        }

        func viewForZooming(in scrollView: UIScrollView) -> UIView? { host.view }
    }

    func makeUIView(context: Context) -> Scroll {
        let view = Scroll(content: content)
        view.panGestureRecognizer.minimumNumberOfTouches = oneFingerPan ? 1 : 2
        return view
    }

    func updateUIView(_ view: Scroll, context: Context) {
        view.host.rootView = content
        if view.page != page {
            view.page = page
            view.setZoomScale(1, animated: false)
        }
    }
}
