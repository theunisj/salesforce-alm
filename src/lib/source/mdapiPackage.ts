/*
 * Copyright (c) 2018, salesforce.com, inc.
 * All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import * as path from 'path';

import * as almError from '../core/almError';

// Like Lodash's zipObject.  Create an object with an array of properties and values.
// E.g., zipObject(['a', 'b'], [1, 2]) --> { a: 1, b: 2 }
function zipObject(propsArray, valuesArray) {
  return propsArray.reduce((acc, prop, i) => {
    acc[prop] = valuesArray[i];
    return acc;
  }, {});
}

const folderMetadataTypes = ['ReportFolder', 'DashboardFolder', 'DocumentFolder', 'EmailFolder'];
const folderChildMetadataTypes = ['Report', 'Dashboard', 'Document', 'EmailTemplate'];

/**
 * Moves folder names listed under folder type in manifest file to respective child type.
 * inputManifestElements array of elements where each element is a JSON representation of a metadata type
 *                       in manifest file.
 * return modified input wherein all folder elements are removed and all folder members listed under
 folder's child element.
 */
function _mergeFolderMembersUnderFolderChildAndUpdateSharingRules(inputManifestElements, metadataRegistry) {
  const FOLDER_TO_CHILD_METADATA_TYPE_MAP = zipObject(folderMetadataTypes, folderChildMetadataTypes);

  const folderManifestElements = {};
  const folderChildManifestElements = {};

  inputManifestElements.forEach(element => {
    if (folderMetadataTypes.includes(element.name)) {
      folderManifestElements[element.name] = element;
    } else if (folderChildMetadataTypes.includes(element.name)) {
      folderChildManifestElements[element.name] = element;
    }
  });

  const newFolderChildManifestElements = [];

  Object.keys(folderManifestElements).forEach(folderMetadataType => {
    const folderManifestElement = folderManifestElements[folderMetadataType];
    const folderChildMetadataType = FOLDER_TO_CHILD_METADATA_TYPE_MAP[folderMetadataType];
    const folderChildManifestElement = folderChildManifestElements[folderChildMetadataType];
    if (folderChildManifestElement) {
      folderChildManifestElement.members.push(...folderManifestElement.members);
    } else {
      newFolderChildManifestElements.push({
        members: folderManifestElement.members,
        name: folderChildMetadataType
      });
    }
  });

  const updatedManifestElements = [];
  let sharingEntities = [];
  if (metadataRegistry) {
    sharingEntities = metadataRegistry.typeDefs.SharingRules.childXmlNames;
  }

  inputManifestElements.forEach(element => {
    if (folderMetadataTypes.indexOf(element.name) >= 0) {
      // Do nothing. We don't want folder types included in the list of types for manifest!
    } else if (folderChildMetadataTypes.indexOf(element.name) >= 0) {
      updatedManifestElements.push(folderChildManifestElements[element.name]);
    } else if (sharingEntities.indexOf(element.name) >= 0) {
      sharingEntities.forEach(sharingEntity => {
        updatedManifestElements.push({
          name: sharingEntity,
          members: element.members
        });
      });
    } else {
      updatedManifestElements.push(element);
    }
  });

  if (newFolderChildManifestElements.length > 0) {
    updatedManifestElements.push(...newFolderChildManifestElements);
  }
  return updatedManifestElements;
}

/**
 * the class is intended to generate a data structure need by manifestCreateApi createManifest
 */
class MdapiPackage {
  // TODO: proper property typing
  [property: string]: any;

  /**
   * ctor - creates a default package structure.
   */
  constructor(force?) {
    const Force = require('../core/force'); // eslint-disable-line global-require

    this.force = force || new Force();

    // attempt to get a source version from sourceApiVersion first then default to apiVersion
    const config = this.force.getConfig();
    const configSourceApiVersion = config.getAppConfig().sourceApiVersion;

    const version = configSourceApiVersion != null ? configSourceApiVersion : config.getApiVersion();

    this.Package = {
      $: {
        xmlns: 'http://soap.sforce.com/2006/04/metadata'
      },
      types: []
    };

    this.setVersion(version);
  }

  /**
   * Set the package version
   * @param version the version intended to be included in package.xml
   */
  setVersion(version) {
    if (version != null) {
      if (version.match(/[0-9]*.0/)) {
        this.Package.version = version;
      } else {
        throw almError('invalidVersionString');
      }
    }
  }

  /**
   * Set the package name
   * @param packageName name of the package to associate the metadata with, null == don't associate with package
   */
  setPackageName(packageName) {
    this.Package.fullName = packageName;
  }

  isEmpty() {
    return this.Package.types.length < 1;
  }

  /**
   * Convert a Folder MD type from a manifest (package.xml) entry to the name used in
   * a client side representation such as a key in a map of AggregateSourceElements.
   * @param type {string} the name of the folder MD type from the package.xml.
   *      E.g., Document --> DocumentFolder
   */
  static convertFolderTypeKey(type) {
    const folderTypeMap = zipObject(folderChildMetadataTypes, folderMetadataTypes);
    return folderTypeMap[type];
  }

  /**
   * Add a member with a type to the data structure. The type is created if it doesn't already exists
   * @param fullName - the fullname attribute from the source metadata member
   * @param type - the type also contained in the source metadata member fullname attribute
   */
  addMember(fullName, type) {
    // param validation
    if (fullName == null || fullName.trim().length === 0) {
      throw almError('fullNameIsRequired');
    }

    if (type == null || type.trim().length === 0) {
      throw almError('metadataTypeIsRequired');
    }

    const types = this.Package.types;

    // find the type attribute
    let localType = types.find(elementType => elementType.name === type);

    // If not found create one an poke the reference
    if (!localType) {
      localType = {
        name: type.trim()
      };
      types.push(localType);
    }

    // create members
    if (!localType.members) {
      localType.members = [];
    }

    let fullNameTrimmed = fullName.trim();

    // Bundle components require special handling
    if (type === 'AuraDefinitionBundle' || type === 'LightningComponentBundle' || type === 'WaveTemplateBundle') {
      const names = fullNameTrimmed.split(path.sep);
      fullNameTrimmed = names[0];
    }

    // on Windows, the package.xml must use forward slashes,
    // except for layouts, which can have backslashes
    if (type !== 'Layout') {
      fullNameTrimmed = fullNameTrimmed.replace(/\\/g, '/');
    }

    // don't support duplicates
    const member = localType.members.find(memberElement => memberElement === fullNameTrimmed);

    // push a member
    if (!member) {
      localType.members.push(fullNameTrimmed);
    }
  }

  /**
   * this function "fixes" up folder types and sorts all type members within.
   * @returns {MdapiPackage}
   */
  getPackage(metadataRegistry) {
    this.Package.types = _mergeFolderMembersUnderFolderChildAndUpdateSharingRules(this.Package.types, metadataRegistry);

    this.Package.types.forEach(type => {
      type.members.sort();
    });

    return { Package: this.Package };
  }
}

export = MdapiPackage;
