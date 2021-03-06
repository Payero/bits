/**
Copyright 2017 LGS Innovations

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
**/
(() => {
  'use strict';

  const path = require('path');
  const Key = require('../utils/key');
  const UtilFs = require('../helpers/fs');
  const UtilChildProcess = require('../helpers/child-process');
  const CryptoMessenger = require('./crypto-messenger');

  const SCRIPTS_DIR = path.join(__dirname, '../../support/scripts');
  const DECRYPT_DATA_CMD = path.resolve(SCRIPTS_DIR, './decrypt-data');
  const ENCRYPT_FILE_CMD = path.resolve(SCRIPTS_DIR, './encrypt-data');

  class CryptoManager {
    constructor(keyManager) {
      this._keyManager = keyManager;
      this._messenger = new CryptoMessenger(this);
    }

    load(messageCenter) {
      return Promise.resolve()
      .then(() => this._messenger.load(messageCenter));
    }

    unload() {
      return Promise.resolve()
      .then(() => this._messenger.unload());
    }

    decryptFileWithKey(filepath, outdir, encryptionKeyHash, signatureKeyHash) {
      return this.decryptFileWithKeyAndOffset(filepath, outdir, encryptionKeyHash, signatureKeyHash, 0);
    }

    decryptFileWithKeyAndOffset(filepath, outdir, encryptionKeyHash, signatureKeyHash, offset) {
      let encryptionKey = this._keyManager.getKeyByHash(encryptionKeyHash);
      if (!encryptionKey) {
        return Promise.reject(new Error('Encryption key not found'));
      } else if (!encryptionKey.isPrivate()) {
        return Promise.reject(new Error('Encryption key must be a private key'));
      }

      let signatureKey = (signatureKeyHash ? this._keyManager.getKeyByHash(signatureKeyHash) : this._keyManager.getBitsSignaturePublicKey());
      if (!signatureKey) {
        return Promise.reject(new Error('Signature key not found'));
      } else if (!signatureKey.isPublic()) {
        return Promise.reject(new Error('Signature key must be a public key'));
      }

      return this._runDecryptFileScript(filepath, offset, outdir, encryptionKey.path, signatureKey.path);
    }

    decryptFile(filepath, outdir, options) {
      return this.decryptFileWithOffset(filepath, 0, outdir, options);
    }

    decryptFileWithOffset(filepath, offset, outdir, options) {
      let signatureKeyFilepath = null;
      options = options || {};
      return this._keyManager.getBitsSignaturePublicKey()
      .then((bitsSignatureKey) => {
        const signatureKey = options.signatureKey || bitsSignatureKey;
        if (!signatureKey) {
          return Promise.reject(new Error('No signature key provided'));
        }
        signatureKeyFilepath = signatureKey.path;
        return this._keyManager.getPrivateKeyList();
      })
      .then((privateKeys) => {
        return privateKeys.reduce((chain, encryptionKey) => {
          return chain.catch((err) => {
            const encryptionKeyFilepath = encryptionKey.path;
            return this._runDecryptFileScript(filepath, offset, outdir, encryptionKeyFilepath, signatureKeyFilepath);
          });
        }, Promise.reject(new Error('No private keys')));
      });
    }

    _runDecryptFileScript(filepath, offset, outdir, encryptionKeyPath, signatureKeyPath) {
      // Create decrypt-data script arguments
      const args = [
        '-t', filepath, // The file path to the file to be decrypted
        '-d', outdir, // The file path to the output (decrypted file)
        '-e', encryptionKeyPath, // The file path to the private key to decrypt with
        '-s', signatureKeyPath, // The file path for the signature verification key
        '-o', offset // The offset to start of encrypted blob
      ];

      // Create options for the decrypt-data script
      const options = {
        cwd: SCRIPTS_DIR // Run the script in the script directory for linux
      };

      // Spawn the decrypt-module script process
      return UtilChildProcess.createSpawnPromise(DECRYPT_DATA_CMD, args, options)
      .then((result) => {
        if (0 === result.code) {
          // The last output of the script is the filename of the decrypted module.
          const decryptedFilename = result.stdout[result.stdout.length - 1].trim();
          const decryptedFilepath = path.resolve(outdir, decryptedFilename);

          // Return the file path to the decrypted module
          return decryptedFilepath;
        } else if (1 === result.code) {
          return Promise.reject(new Error('incorrect arguments supplied, files incorrect, or key not private'));
        } else if (2 === result.code) {
          return Promise.reject(new Error('failed signature verification'));
        } else if (3 === result.code) {
          return Promise.reject(new Error('failed RSA decryption'));
        } else if (4 === result.code) {
          return Promise.reject(new Error('failed AES decryption'));
        } else {
          return Promise.reject(new Error('Unknown exit code: ' + result.code));
        }
      });
    }

    encryptFile(filepath, encryptionKey, signatureKey, outdir) {
      if (!(encryptionKey instanceof Key) || !encryptionKey.isPublic()) {
        return Promise.reject(new Error('encryption key must be a public key.'));
      }

      if (!(signatureKey instanceof Key) || !signatureKey.isPrivate()) {
        return Promise.reject(new Error('signature key key must be a private key.'));
      }

      return UtilFs.stat(outdir)
      .then((stats) => {
        if (!stats.isDirectory()) {
          return Promise.reject(new TypeError('outdir is not a directory.'));
        }
      })
      .then(() => {
        const args = [
          '-t', filepath,
          '-e', encryptionKey.getFilepath(),
          '-s', signatureKey.getFilepath(),
          '-d', outdir,
          '-a'
        ];

        const options = {
          cwd: SCRIPTS_DIR
        };

        return UtilChildProcess.spawn(ENCRYPT_FILE_CMD, args, options);
      })
      .then((results) => {
        if (0 === results.code) {
          const encryptedFilename = results.stdout[results.stdout.length - 1].trim();
          const encryptedFilepath = path.resolve(outdir, encryptedFilename);
          return encryptedFilepath;
        } else {
          return Promise.reject(new Error('Unknown exit code: ' + results.code));
        }
      });
    }

    encryptFileWithAvailableKeys(filepath, outdir) {
      let encryptionKey = null;
      let signatureKey = null;

      return this.getAvailableEncryptionKey()
      .then((key) => {
        encryptionKey = key;
        return this.getAvailableSignatureKey();
      })
      .then((key) => {
        signatureKey = key;
        return this.encryptFile(filepath, encryptionKey, signatureKey, outdir);
      })
      .then((filepath) => {
        return {
          signatureKey: signatureKey,
          encryptionKey: encryptionKey,
          filepath: filepath
        };
      });
    }

    getAvailableEncryptionKey() {
      return this._keyManager.getBitsSignaturePublicKey()
      .then((keys) => {
        if (null === keys) {
          return this._keyManager.getPublicKeyList()
          .then((keys) => {
            if (0 < keys.length) {
              return keys[0];
            } else {
              return null;
            }
          });
        } else {
          return keys;
        }
      })
      .then((key) => {
        if (null === key) {
          return Promise.reject(new Error('No available public key to encrypt data.'));
        } else {
          return key;
        }
      });
    }

    getAvailableSignatureKey() {
      return Promise.resolve()
      .then(() => this._keyManager.getDefaultPrivateKey())
      .then((key) => {
        if (null === key) {
          return Promise.resolve()
          .then(() => this._keyManager.getPrivateKeyList())
          .then((keys) => keys.filter((key) => 'device' !== key.getFileName()))
          .then((keys) => {
            if (0 < keys.length) {
              return keys[0];
            } else {
              return null;
            }
          });
        } else {
          return key;
        }
      })
      .then((key) => {
        if (null === key) {
          return Promise.reject(new Error('No available private key to sign data.'));
        } else {
          return key;
        }
      });
    }

    getKeyByHash(hash) {
      return this._keyManager.getKeyByHash(hash);
    }
  }
  module.exports = CryptoManager;
})();
