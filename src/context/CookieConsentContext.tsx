import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useMemo,
  useRef,
} from "react";
import CookieConsenter from "../components/CookieConsenter";
import type {
  CookieCategories,
  CookieConsenterProps,
  DetailedCookieConsent,
  TranslationObject,
  TranslationFunction,
} from "../types/types";
import { ManageConsent } from "../components/ManageConsent";
import { getBlockedHosts, getBlockedKeywords } from "../utils/tracker-utils";
import { createTFunction } from "../utils/translations";

// Store original functions
let originalXhrOpen: typeof XMLHttpRequest.prototype.open | null = null;
let originalFetch: typeof window.fetch | null = null;

const blockTrackingRequests = (blockedHosts: string[]) => {
  // Store original functions if not already stored
  if (!originalXhrOpen) {
    originalXhrOpen = XMLHttpRequest.prototype.open;
  }
  if (!originalFetch) {
    originalFetch = window.fetch;
  }

  // Override XMLHttpRequest to block requests to tracking domains
  XMLHttpRequest.prototype.open = function (method: string, url: string | URL) {
    const urlString = url.toString();
    if (blockedHosts.some((host) => urlString.includes(host))) {
      return;
    }
    return originalXhrOpen!.apply(this, arguments as any);
  };

  // Override fetch API to block tracking requests
  window.fetch = function (url: RequestInfo | URL, options?: RequestInit) {
    const urlString = url.toString();
    if (
      typeof urlString === "string" &&
      blockedHosts.some((host) => urlString.includes(host))
    ) {
      return Promise.resolve(
        new Response(null, { status: 403, statusText: "Blocked" })
      );
    }
    return originalFetch!.apply(this, arguments as any);
  };
};

const blockTrackingScripts = (trackingKeywords: string[]) => {
  // Remove all script tags that match tracking domains
  document.querySelectorAll("script").forEach((script) => {
    if (
      script.src &&
      trackingKeywords.some((keyword) => script.src.includes(keyword))
    ) {
      script.remove();
    }
  });

  // Prevent new tracking scripts from being injected
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node instanceof HTMLElement && node.tagName === "SCRIPT") {
          const src = node.getAttribute("src");
          if (
            src &&
            trackingKeywords.some((keyword) => src.includes(keyword))
          ) {
            node.remove();
          }
        }
      });
    });
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  return observer;
};

const restoreOriginalRequests = () => {
  if (originalXhrOpen) {
    XMLHttpRequest.prototype.open = originalXhrOpen;
  }
  if (originalFetch) {
    window.fetch = originalFetch;
  }
};

interface CookieConsentContextValue {
  hasConsent: boolean | null;
  isDeclined: boolean;
  detailedConsent: DetailedCookieConsent | null;
  showConsentBanner: () => void;
  acceptCookies: () => void;
  declineCookies: () => void;
  updateDetailedConsent: (preferences: CookieCategories) => void;
}

const CookieManagerContext = createContext<CookieConsentContextValue | null>(
  null
);

export interface CookieManagerProps
  extends Omit<CookieConsenterProps, "onAccept" | "onDecline" | "forceShow"> {
  children: React.ReactNode;
  localStorageKey?: string;
  onManage?: (preferences?: CookieCategories) => void;
  disableAutomaticBlocking?: boolean;
  blockedDomains?: string[];
  expirationDays?: number;
  /**
   * Translations that will be used in the consent UI. It can be one of:
   * 1. **TranslationObject**: An object with keys for each TranslationKey, e.g.:
   *    ```
   *    {
   *      title: 'My own consent title',
   *      message: 'My own consent message',
   *      // other keys if needed
   *    }
   *    ```
   * 2. **TranslationFunction**: A function that takes a key with params and returns a string. Useful for i18n libraries where TFunction can be passed like follows:
   *    ```ts
   *    const { t } = useTranslation();
   *    return <CookieConsenter translations={t} />
   *    ```
   *
   * By default it uses English translations specified in TranslationKey defaults.
   */
  translations?: TranslationObject | TranslationFunction<any, any>;
  /**
   * Prefix for translation keys when using i18next, e.g.
   * ```ts
   * // typescript file
   * const { t } = useTranslation();
   * <CookieConsenter translations={t} translationI18NextPrefix="cookieConsent" />
   * ```
   * ```json
   * // {lng}.json
   * {
   *  "cookieConsent": {
   *    "title": "My own consent title",
   *    "message": "My own consent message"
   *  }
   * }
   * ```
   */
  translationI18NextPrefix?: string;
}

const createConsentStatus = (consented: boolean) => ({
  consented,
  timestamp: new Date().toISOString(),
});

const createDetailedConsent = (consented: boolean): DetailedCookieConsent => ({
  Analytics: createConsentStatus(consented),
  Social: createConsentStatus(consented),
  Advertising: createConsentStatus(consented),
});

export const CookieManager: React.FC<CookieManagerProps> = ({
  children,
  localStorageKey = "cookie-consent",
  translations,
  translationI18NextPrefix,
  onManage,
  disableAutomaticBlocking = false,
  blockedDomains = [],
  expirationDays = 365,
  ...props
}) => {
  const [isVisible, setIsVisible] = useState(false);
  const [showManageConsent, setShowManageConsent] = useState(false);
  const tFunction = useMemo(
    () => createTFunction(translations, translationI18NextPrefix),
    [translations, translationI18NextPrefix]
  );

  const [detailedConsent, setDetailedConsent] =
    useState<DetailedCookieConsent | null>(() => {
      const storedConsent = localStorage.getItem(localStorageKey);
      if (storedConsent) {
        try {
          const parsedConsent = JSON.parse(
            storedConsent
          ) as DetailedCookieConsent;

          // Check if consent has expired
          const oldestTimestamp = Math.min(
            ...Object.values(parsedConsent).map((status) =>
              new Date(status.timestamp).getTime()
            )
          );

          const expirationTime =
            oldestTimestamp + expirationDays * 24 * 60 * 60 * 1000;

          if (Date.now() > expirationTime) {
            localStorage.removeItem(localStorageKey);
            return null;
          }

          return parsedConsent;
        } catch (e) {
          return null;
        }
      }
      return null;
    });

  const hasConsent = detailedConsent
    ? Object.values(detailedConsent).some((status) => status.consented)
    : null;

  const observerRef = useRef<MutationObserver | null>(null);

  useEffect(() => {
    // Show banner if no consent decision has been made AND manage consent is not shown
    if (detailedConsent === null && !showManageConsent) {
      setIsVisible(true);
    }

    // Handle tracking blocking
    if (!disableAutomaticBlocking) {
      // Get current preferences
      const currentPreferences = detailedConsent
        ? {
            Analytics: detailedConsent.Analytics.consented,
            Social: detailedConsent.Social.consented,
            Advertising: detailedConsent.Advertising.consented,
          }
        : null;

      // Get blocked hosts and keywords based on preferences
      const blockedHosts = [
        ...getBlockedHosts(currentPreferences),
        ...blockedDomains,
      ];
      const blockedKeywords = [
        ...getBlockedKeywords(currentPreferences),
        ...blockedDomains,
      ];

      if (blockedHosts.length > 0) {
        blockTrackingRequests(blockedHosts);
        observerRef.current = blockTrackingScripts(blockedKeywords);
      } else {
        // If no hosts are blocked, restore original functions
        restoreOriginalRequests();
        if (observerRef.current) {
          observerRef.current.disconnect();
          observerRef.current = null;
        }
      }
    } else {
      // If blocking is disabled, restore original functions
      restoreOriginalRequests();
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }
    }

    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
    };
  }, [detailedConsent, disableAutomaticBlocking, blockedDomains]);

  const showConsentBanner = () => {
    if (!showManageConsent) {
      // Only show banner if manage consent is not shown
      setIsVisible(true);
    }
  };

  const acceptCookies = () => {
    const newConsent = createDetailedConsent(true);
    localStorage.setItem(localStorageKey, JSON.stringify(newConsent));
    setDetailedConsent(newConsent);
    setIsVisible(false);
  };

  const declineCookies = () => {
    const newConsent = createDetailedConsent(false);
    localStorage.setItem(localStorageKey, JSON.stringify(newConsent));
    setDetailedConsent(newConsent);
    setIsVisible(false);
  };

  const updateDetailedConsent = (preferences: CookieCategories) => {
    const timestamp = new Date().toISOString();
    const newConsent: DetailedCookieConsent = {
      Analytics: { consented: preferences.Analytics, timestamp },
      Social: { consented: preferences.Social, timestamp },
      Advertising: { consented: preferences.Advertising, timestamp },
    };
    localStorage.setItem(localStorageKey, JSON.stringify(newConsent));
    setDetailedConsent(newConsent);
    setShowManageConsent(false);
    if (onManage) {
      onManage(preferences);
    }
  };

  const handleManage = () => {
    setIsVisible(false);
    setShowManageConsent(true);
  };

  const handleCancelManage = () => {
    setShowManageConsent(false);
    setIsVisible(true);
  };

  const value: CookieConsentContextValue = {
    hasConsent,
    isDeclined: hasConsent === false,
    detailedConsent,
    showConsentBanner,
    acceptCookies,
    declineCookies,
    updateDetailedConsent,
  };

  return (
    <CookieManagerContext.Provider value={value}>
      {children}
      {isVisible && (
        <CookieConsenter
          {...props}
          tFunction={tFunction}
          localStorageKey={localStorageKey}
          onAccept={acceptCookies}
          onDecline={declineCookies}
          onManage={handleManage}
          detailedConsent={detailedConsent}
          initialPreferences={
            detailedConsent
              ? {
                  Analytics: detailedConsent.Analytics.consented,
                  Social: detailedConsent.Social.consented,
                  Advertising: detailedConsent.Advertising.consented,
                }
              : undefined
          }
        />
      )}
      {showManageConsent && (
        <div className="cookie-manager">
          <div className="fixed inset-0 z-[99999] bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
            <div
              className={`w-full max-w-lg rounded-xl p-6 ${
                props.theme === "light"
                  ? "bg-white/95 ring-1 ring-black/10"
                  : "bg-black/95 ring-1 ring-white/10"
              }`}
            >
              <ManageConsent
                tFunction={tFunction}
                theme={props.theme}
                onSave={updateDetailedConsent}
                onCancel={handleCancelManage}
                initialPreferences={
                  detailedConsent
                    ? {
                        Analytics: detailedConsent.Analytics.consented,
                        Social: detailedConsent.Social.consented,
                        Advertising: detailedConsent.Advertising.consented,
                      }
                    : undefined
                }
                detailedConsent={detailedConsent}
              />
            </div>
          </div>
        </div>
      )}
    </CookieManagerContext.Provider>
  );
};

export const useCookieConsent = () => {
  const context = useContext(CookieManagerContext);
  if (!context) {
    throw new Error("useCookieConsent must be used within a CookieManager");
  }
  return context;
};
