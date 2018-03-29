/**
 * Copyright 2018 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {Services} from '../services';
import {dev, user} from '../log';
import {dict} from '../utils/object';
import {getSourceOrigin} from '../url';

const GOOGLE_CLIENT_ID_API_META_NAME = 'amp-google-client-id-api';
const CID_API_SCOPE_WHITELIST = {
  'googleanalytics': 'AMP_ECID_GOOGLE',
};
const API_KEYS = {
  'googleanalytics': 'AIzaSyA65lEHUEizIsNtlbNo-l2K18dT680nsaM',
};

/**
 * The Client ID service key.
 * @const @private {string}
 */
const SERVICE_KEY_ = 'AIzaSyDKtqGxnoeIqVM33Uf7hRSa3GJxuzR7mLc';

const TAG = 'CacheCidApi';
const CACHE_API_URL = 'https://ampcid.google.com/v1/cache:getClientId?key=';

const TIMEOUT = 30000;

/**
 * Exposes CID API for cache-served pages without a viewer.
 */
export class CacheCidApi {

  constructor(ampdoc) {

    /** @private {!./ampdoc-impl.AmpDoc} */
    this.ampdoc_ = ampdoc;

    /** @private {!./viewer-impl.Viewer} */
    this.viewer_ = Services.viewerForDoc(this.ampdoc_);

    /** @private {?Object<string, string>} */
    this.apiKeyMap_ = null;

    /** @private {?Promise<?string>} */
    this.publisherCidPromise_ = null;

    /** @private {!./timer-impl.Timer} */
    this.timer_ = Services.timerFor(this.ampdoc_.win_);
  }

  /**
   * Resolves to true if Viewer is trusted and supports CID API.
   * @returns {!Promise<boolean>}
   */
  isSupported() {
    if (!this.viewer_.isCctEmbedded()) {
      return Promise.resolve(false);
    }
    if (!this.viewer_.isProxyOrigin()) {
      return Promise.resolve(false);
    }
    return this.viewer_.isTrustedViewer(); // TODO maybe true?
  }

  /**
   * Returns scoped CID retrieved from the Viewer.
   * @param {string} scope
   * @return {!Promise<?string>}
   */
  getScopedCid(scope) {
    // promise for whether we do stuff at all
    if (!this.viewer_.isCctEmbedded()) {
      return Promise.resolve(null);
    }

    const apiKey = this.isScopeOptedIn(scope);
    if (!apiKey) {
      return Promise.resolve(null);
    }

    if (!this.publisherCidPromise_) {
      const url = CACHE_API_URL + SERVICE_KEY_;
      this.publisherCidPromise_ = this.fetchCid_(url);
    }

    return this.publisherCidPromise_.then(publisherCid => {
      return this.scopeCid_(publisherCid, scope);
    });
  }

  /**
   * Returns scoped CID retrieved from the Viewer.
   * @param {string} url
   * @return {!Promise<?string>}
   */
  fetchCid_(url) {
    const payload = dict({
      'publisherOrigin': getSourceOrigin(this.ampdoc.win.location),
    });

    // Make the XHR request to the cache endpoint.
    return this.timer_.timeoutPromise(
        TIMEOUT,
        Services.xhrFor(this.win_).fetchJson(url, {
          method: 'POST',
          ampCors: false,
          credentials: 'include',
          mode: 'cors',
          body: payload,
        }).then(res => {
	  const response = res.json();
	  if (response['optOut']) {
	    return null;
	  }
	  const cid = response['publisherClientId'];
          if (!cid && response['alternateUrl']) {
            // If an alternate url is provided, try again with the alternate url
            // The client is still responsible for appending API keys to the URL.
            const alt = `${response['alternateUrl']}?key=${SERVICE_KEY_}`;
            return this.fetchCid_(dev().assertString(alt))
                .then(altRes => {
                  return altRes.json()['publisherClientId'] || null;
                });
	  }
          return cid;
        }).catch(e => {
          if (e && e.response) {
            e.response.json().then(res => {
              dev().error(TAG, JSON.stringify(res));
            });
          } else {
            dev().error(TAG, e);
          }
          return null;
        }));
  }

  /**
   * Returns scoped CID extracted from the fetched publisherCid.
   * @param {string} publisherCid
   * @param {string} scope
   * @return {?string}
   */
  scopeCid_(publisherCid, scope) {
    if (!publisherCid) {
      return Promise.resolve(null);
    }
    const text = publisherCid + ';' + scope;
    return Services.cryptoFor(this.ampdoc.win).sha384Base64(text).then(enc => {
      return 'amp-' + enc;
    });
  }

  /**
   * Checks if the page has opted in CID API for the given scope.
   * Returns the API key that should be used, or null if page hasn't opted in.
   *
   * @param {string} scope
   * @return {string|undefined}
   */
  isScopeOptedIn(scope) {
    if (!this.apiKeyMap_) {
      this.apiKeyMap_ = this.getOptedInScopes_();
    }
    return this.apiKeyMap_[scope];
  }

  /**
   * @return {!Object<string, string>}
   */
  getOptedInScopes_() {
    const apiKeyMap = {};
    const optInMeta = this.ampdoc_.win.document.head./*OK*/querySelector(
        `meta[name=${GOOGLE_CLIENT_ID_API_META_NAME}]`);
    if (optInMeta && optInMeta.hasAttribute('content')) {
      const list = optInMeta.getAttribute('content').split(',');
      list.forEach(item => {
        item = item.trim();
        if (item.indexOf('=') > 0) {
          const pair = item.split('=');
          const scope = pair[0].trim();
          apiKeyMap[scope] = pair[1].trim();
        } else {
          const clientName = item;
          const scope = CID_API_SCOPE_WHITELIST[clientName];
          if (scope) {
            apiKeyMap[scope] = API_KEYS[clientName];
          } else {
            user().error(TAG,
                `Unsupported client for Google CID API: ${clientName}`);
          }
        }
      });
    }
    return apiKeyMap;
  }
}
