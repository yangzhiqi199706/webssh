import { t } from '../i18n';
// import httpsend from '../Assets/httpsend';

export default {
    PreviewDeal(iamges, procotol, allDevcom, histroydata, paramdata, snmplist, historyparamdata, alarmdata) {
        // Comment translated to English.
        // console.log(JSON.stringify(histroydata))
        // console.log(paramdata)
        // console.log(snmplist)
        // console.log(historyparamdata)
        // console.log(alarmdata)
        if (!procotol || !allDevcom) {
            console.log(t('auto.k0600'))
            return false
        }
        const normalizeValue = (v) => (v === undefined || v === null ? '' : v.toString().trim());
        const resolveAlarmLevelMeta = (rawLevel) => {
            const level = normalizeValue(rawLevel);
            switch (level) {
                case '1':
                    return { colorName: 'level1color', levelName: t('auto.k0602') };
                case '2':
                    return { colorName: 'level2color', levelName: t('auto.k0603') };
                case '3':
                    return { colorName: 'level3color', levelName: t('auto.k0604') };
                case '4':
                    return { colorName: 'level4color', levelName: t('auto.k0605') };
                case '5':
                    return { colorName: 'level5color', levelName: t('auto.k0606') };
                // Compatible fallback for extended levels:
                // 0 -> treat as lowest, >=6 -> treat as highest.
                case '0':
                    return { colorName: 'level1color', levelName: '' };
                case '6':
                case '7':
                case '8':
                case '9':
                    return { colorName: 'level5color', levelName: t('auto.k0606') };
                default:
                    return { colorName: 'level1color', levelName: '' };
            }
        };
        const sameId = (a, b) => normalizeValue(a) === normalizeValue(b);

        // Comment translated to English.
        const dealProcotol = () => {
            // let startviewTime = new Date().getTime();
            let resArr = [];
            let protocolList = [];
            if (Array.isArray(procotol && procotol.data)) {
                protocolList = procotol.data;
            } else if (procotol && procotol.data && typeof procotol.data === 'object') {
                protocolList = [procotol.data];
            } else if (procotol && typeof procotol.data === 'string') {
                let rawData = procotol.data.trim();
                if (rawData && (rawData[0] === '{' || rawData[0] === '[')) {
                    try {
                        let parsedData = JSON.parse(rawData);
                        protocolList = Array.isArray(parsedData) ? parsedData : [parsedData];
                    } catch (error) {
                        protocolList = [procotol];
                    }
                } else {
                    protocolList = [procotol];
                }
            } else if (procotol) {
                protocolList = [procotol];
            }

            const pushProtocolItem = (item) => {
                if (!item || !item.ProtocolCode || !item.comType || !item.keyName || !Array.isArray(item.keyDesc) || item.keyDesc.length === 0) {
                    return;
                }
                item.ProtocolCode = normalizeValue(item.ProtocolCode);
                item.comType = normalizeValue(item.comType);
                item.keyName = normalizeValue(item.keyName);
                item.keyDesc = item.keyDesc.map(v => normalizeValue(v)).filter(v => v && v.indexOf('=') > -1);
                if (!item.ProtocolCode || !item.comType || !item.keyName || item.keyDesc.length === 0) {
                    return;
                }
                let findIndex = resArr.findIndex(v => normalizeValue(v.ProtocolCode) === item.ProtocolCode && normalizeValue(v.comType) === item.comType && normalizeValue(v.keyName) === item.keyName);
                if (findIndex === -1) {
                    resArr.push(item);
                } else {
                    resArr[findIndex] = item;
                }
            }

            const parseV2Protocol = (protocolObj, fallbackCode = '') => {
                if (!protocolObj || !Array.isArray(protocolObj.parseModels)) return;
                let protocolCode = fallbackCode || (protocolObj.protocolMeta && protocolObj.protocolMeta.ProtocolCode) || protocolObj.ProtocolCode || '';
                protocolObj.parseModels.forEach((model) => {
                    if (!model) return;
                    let type = model.CommandType ? model.CommandType.toString() : '';
                    let params = Array.isArray(model.Params) ? model.Params : [];
                    params.forEach((param) => {
                        if (!param) return;
                        let keyName = normalizeValue(param.AlarmKey || param.ParamName || '');
                        if (!keyName) return;
                        let dataType = normalizeValue(param.DataType);
                        let rawDesc = '';
                        if (typeof param.Unit === 'string' && param.Unit.indexOf('=') > -1) {
                            rawDesc = param.Unit;
                        } else if (typeof param.DataList === 'string' && param.DataList.indexOf('=') > -1) {
                            rawDesc = param.DataList;
                        }
                        rawDesc = normalizeValue(rawDesc).replace(/\\\//g, '/');
                        let descArr = rawDesc ? rawDesc.split('/').map(v => normalizeValue(v)).filter(v => v && v.indexOf('=') > -1) : [];
                        pushProtocolItem({
                            'ProtocolCode': protocolCode,
                            'comType': type,
                            'keyName': keyName,
                            'keyDesc': descArr,
                            'dataType': dataType
                        })
                    })
                })
            }

            const tryParseV2Protocol = (rawProtocol, fallbackCode = '') => {
                if (!rawProtocol) return false;
                if (Array.isArray(rawProtocol)) {
                    let matched = false;
                    rawProtocol.forEach((it) => {
                        if (it && Array.isArray(it.parseModels)) {
                            parseV2Protocol(it, fallbackCode);
                            matched = true;
                        }
                    });
                    return matched;
                }
                if (typeof rawProtocol === 'object') {
                    if (Array.isArray(rawProtocol.parseModels)) {
                        parseV2Protocol(rawProtocol, fallbackCode);
                        return true;
                    }
                    return false;
                }
                if (typeof rawProtocol === 'string') {
                    let text = rawProtocol.trim();
                    if (!text || (text[0] !== '{' && text[0] !== '[')) return false;
                    try {
                        let parsed = JSON.parse(text);
                        return tryParseV2Protocol(parsed, fallbackCode);
                    } catch (error) {
                        return false;
                    }
                }
                return false;
            }

            protocolList.forEach((value) => {
                if (!value) return;
                let fallbackCode = value.ProtocolCode || '';

                // New protocol format: { version:2, protocolMeta, parseModels }
                if (tryParseV2Protocol(value, fallbackCode)) {
                    return;
                }
                // New protocol format in ProtocolJson (json string/object)
                if (tryParseV2Protocol(value.ProtocolJson, fallbackCode)) {
                    return;
                }
                // Some services put the v2 protocol JSON inside ProtocolData.
                if (tryParseV2Protocol(value.ProtocolData, fallbackCode)) {
                    return;
                }
                let ProtocolData = value.ProtocolData;// Comment translated to English.
                if (!ProtocolData) return;

                let proArr = [];
                if (typeof ProtocolData === 'string' && ProtocolData.indexOf('|') > -1) {
                    proArr = ProtocolData.split('|');// Comment translated to English.
                } else {
                    proArr.push(ProtocolData)
                }

                // Comment translated to English.
                proArr.forEach((val) => {
                    if (!val || typeof val !== 'string') {// Comment translated to English.
                        return true;
                    }
                    let commandOne = val.split('&');// Comment translated to English.
                    if (commandOne.length < 3 || !commandOne[1] || !commandOne[2]) return true;
                    let type = commandOne[0];//B1
                    let dealType = commandOne[1].indexOf('<') > -1 ? commandOne[1].split('<')[0] : commandOne[1];//4 or 4<0-13>
                    let paramArr = commandOne[2].split(':');// Comment translated to English.
                    let dealNum = 3;// Comment translated to English.
                    switch (dealType) {
                        // case '1':
                        // case '6':
                        // case '7':
                        // case '9':
                        //     dealNum = 3;
                        //     break;
                        case '2':
                        case '4':
                            dealNum = 2;
                            break;
                        case '3':
                        case '5':
                        case '8':
                            dealNum = 4;
                            break;
                        default: dealNum = 3; break;
                    }
                    paramArr.forEach((y) => {// Comment translated to English.
                        if (y) {
                            let paramOneArr = y.split(',');
                            let descArr = [];
                            let datatype = paramOneArr.length > 0 ? normalizeValue(paramOneArr[paramOneArr.length - 1]) : '';// Comment translated to English.
                            if (paramOneArr[dealNum] && paramOneArr[dealNum].indexOf('/') > -1) {
                                descArr = paramOneArr[dealNum].split('/').map(v => normalizeValue(v)).filter(v => v && v.indexOf('=') > -1);
                                pushProtocolItem({
                                    'ProtocolCode': normalizeValue(value.ProtocolCode),
                                    'comType': normalizeValue(type),// Comment translated to English.
                                    'keyName': normalizeValue(paramOneArr[1]),// Comment translated to English.
                                    'keyDesc': descArr,// Comment translated to English.
                                    'dataType': datatype// Comment translated to English.
                                })
                            }
                        }
                    })
                })
            })
            // localStorage.setItem('proctol',JSON.stringify(resArr));
            // let endviewTime = new Date().getTime();
            // Comment translated to English.
            return resArr;
        }

        let newProcotol = dealProcotol();// Comment translated to English.
        // Comment translated to English.
        // Comment translated to English.
        // console.log('newProcotol-----------------------');
        // console.log(newProcotol);


        // Comment translated to English.
        const dealParam = (val, type = '') => {
            let jsonarr;
            if (val.LastReceiveData || val.Data) {
                let LastReceiveData = val.LastReceiveData || val.Data;
                LastReceiveData = LastReceiveData.replace(/'/g, '"');
                jsonarr = JSON.parse(LastReceiveData);
            }
            if (type === 3) {
                return setDataNewVal(type, '', jsonarr);
            } else {
                if (val.Data) {// Comment translated to English.
                    return setDataNewVal(val.CommandType, '', jsonarr, val.DevID);
                } else {// Comment translated to English.
                    return setDataNewVal(val.CommandType, val.ProtocolCode, jsonarr);
                }
            }
        }

        // Comment translated to English.
        // Comment translated to English.
        // Comment translated to English.
        // Comment translated to English.
        // Comment translated to English.
        const setDataNewVal = (CommandType, ProtocolCode, jsonarr, DevID = '') => {
            if (CommandType === '3') {
                if (snmplist && snmplist.data.length > 0) {
                    for (let key in jsonarr) {
                        let findtxtArr = snmplist.data.find(v => v.OIDName === key)// Comment translated to English.
                        if (findtxtArr) {
                            if (findtxtArr.DataList && findtxtArr.DataList.indexOf('/') > -1) {
                                let descOneArr = findtxtArr.DataList.split('/');// Comment translated to English.
                                let findtxt = descOneArr.find(v => parseFloat(v.split('=')[0]) === parseFloat(jsonarr[key]));
                                if (findtxt) {
                                    let desc = findtxt.split('=')[1];
                                    jsonarr[key] = desc;
                                }
                            }
                        }
                    }
                }
            } else {
                let findcodeIndex = -1;
                if (DevID) {// Comment translated to English.
                    findcodeIndex = allDevcom.data.findIndex(v => sameId(v.DevID, DevID))
                    if (findcodeIndex !== -1) ProtocolCode = allDevcom.data[findcodeIndex]['ProtocolCode'];
                }
                for (let key in jsonarr) {
                    let findtxtArr = getProcotol(CommandType, ProtocolCode, key);
                    // console.log(CommandType)
                    // console.log(ProtocolCode)
                    // console.log(key)
                    // Comment translated to English.
                    if (findtxtArr) {
                        let findtxt = '';
                        let valueStr = normalizeValue(jsonarr[key]);
                        if (Array.isArray(findtxtArr.keyDesc)) {
                            // Enum values like 011/010 should match by string first.
                            findtxt = findtxtArr.keyDesc.find(v => normalizeValue(v.split('=')[0]) === valueStr);
                        }
                        if (!findtxt && findtxtArr.dataType !== '3' && Array.isArray(findtxtArr.keyDesc)) {
                            let valueNum = parseFloat(valueStr);
                            if (!Number.isNaN(valueNum)) {
                                findtxt = findtxtArr.keyDesc.find(v => {
                                    let keyNum = parseFloat(normalizeValue(v.split('=')[0]));
                                    return !Number.isNaN(keyNum) && keyNum === valueNum;
                                });
                            }
                        }
                        if (findtxt) {
                            let desc = findtxt.split('=')[1];
                            jsonarr[key] = desc;
                        }
                    }
                }
            }

            return jsonarr;
        }

        // Comment translated to English.
        // Comment translated to English.
        // Comment translated to English.
        // Comment translated to English.
        // Comment translated to English.
        // Comment translated to English.
        //     'ProtocolData':value.ProtocolCode,
        // Comment translated to English.
        // Comment translated to English.
        // Comment translated to English.
        // Comment translated to English.
        // }
        const getProcotol = (recvType, ProtocolCode, keyName) => {
            if (!newProcotol) return false;
            // console.log(newProcotol)
            // Comment translated to English.
            //     console.log(recvType)
            //     console.log(ProtocolCode)
            //     console.log(keyName)
            // }
            let findkey = newProcotol.find(v => normalizeValue(v.ProtocolCode) === normalizeValue(ProtocolCode) && normalizeValue(v.comType) === normalizeValue(recvType) && normalizeValue(v.keyName) === normalizeValue(keyName));
            // console.log(newProcotol);
            // Comment translated to English.
            return findkey;
        }

        // Comment translated to English.
        const dealCommandData = () => {
            // let startviewTime = new Date().getTime();
            allDevcom.data.forEach((value) => {
                value.collectData = dealParam(value, value.CommandType)// Comment translated to English.
            })
            // let endviewTime = new Date().getTime();
            // Comment translated to English.
            return allDevcom.data;
        }
        let newCommandData = dealCommandData();

        // Comment translated to English.
        const dealHistoryData = () => {
            // let startviewTime = new Date().getTime();
            if (histroydata && histroydata.data) {
                let histroydataInit = JSON.parse(JSON.stringify(histroydata)).data;
                histroydataInit.forEach((value) => {
                    value.collectData = dealParam(value, value.CommandType === '0' ? '3' : value.CommandType)// Comment translated to English.
                })
                // let endviewTime = new Date().getTime();
                // Comment translated to English.
                return histroydataInit;
            } else {
                return [];
            }
        }
        let newHistoryData = dealHistoryData();


        // Comment translated to English.
        const getDateTime = (timeStr) => {
            var time = timeStr ? timeStr : new Date();
            var y = time.getFullYear();
            var m = time.getMonth() + 1;
            m = m < 10 ? ("0" + m) : m;
            var d = time.getDate();
            d = d < 10 ? ("0" + d) : d;
            return y + "-" + m + "-" + d;
        }
        // Comment translated to English.
        const getDateTimeHour = (timeStr) => {
            var time = timeStr ? timeStr : new Date();
            var y = time.getFullYear();
            var m = time.getMonth() + 1;
            m = m < 10 ? ("0" + m) : m;
            var d = time.getDate();
            d = d < 10 ? ("0" + d) : d;
            var h = time.getHours();
            h = h < 10 ? ("0" + h) : h;
            return y + "-" + m + "-" + d + " " + h;
        }

        // Comment translated to English.
        async function fetchData(element, newshapeProps, dataWhere) {
            if (!newCommandData) return newshapeProps;
            // console.log(newCommandData);
            let findNewValIndex = newCommandData.findIndex(v => sameId(v.DevID, element.key) && v.collectData && v.collectData[element.name]);// Comment translated to English.
            if (findNewValIndex !== -1) {// Comment translated to English.
                let collectVal = newCommandData[findNewValIndex]['collectData'][element.name];
                // Comment translated to English.
                // console.log(collectVal);
                collectVal = collectVal.indexOf('(') > -1 ? collectVal.split('(')[0] : collectVal;// Comment translated to English.
                // Comment translated to English.
                // console.log(collectVal);
                // Comment translated to English.
                if (newshapeProps.moduleJson.children[0].className === 'Text') {// Comment translated to English.
                    let srcalarm = [];
                    if (alarmdata && alarmdata.data) srcalarm = alarmdata.data.filter(v => sameId(v.DevId, element.key) && v.TextMessage && v.TextMessage.split(',')[2].replace(v.TypeName, '') === element.name); // Comment translated to English.
                    // Comment translated to English.
                    // console.log(srcalarm);
                    if (dataWhere) {// Comment translated to English.
                        let whereval = Number.isFinite(Number(collectVal)) ? dataWhere.find(v => Number(v.conditionNum) === Number(collectVal)) : dataWhere.find(v => v.conditionNum === collectVal);
                        // Comment translated to English.
                        // console.log(whereval);
                        if (whereval) {
                            newshapeProps.moduleJson.children[0].attrs.text = whereval.conditionText;
                            newshapeProps.moduleJson.children[0].attrs.fill = whereval.statusSelectColor;
                        } else {
                            newshapeProps.moduleJson.children[0].attrs.text = collectVal;
                            if (srcalarm.length !== 0 && newshapeProps.moduleJson.children[0].attrs.name !== 'complexTextValue') newshapeProps.moduleJson.children[0].attrs.fill = '#ff2626';
                        }
                    } else {
                        newshapeProps.moduleJson.children[0].attrs.text = collectVal;
                        if (srcalarm.length !== 0 && newshapeProps.moduleJson.children[0].attrs.name !== 'complexTextValue') newshapeProps.moduleJson.children[0].attrs.fill = '#ff2626';
                    }
                }
                if (newshapeProps.moduleJson.children[0].className === 'Image') {// Comment translated to English.
                    if (dataWhere) {// Comment translated to English.
                        // Comment translated to English.
                        // console.log(dataWhere);
                        // console.log(dataWhere);
                        // console.log(collectVal);
                        // console.log(dataWhere.find(v => v.conditionNum === collectVal));
                        let whereval = Number.isFinite(Number(collectVal)) ? (dataWhere.find(v => Number(v.conditionNum) === Number(collectVal))) : (dataWhere.find(v => v.conditionNum === collectVal));
                        // Comment translated to English.
                        // console.log(whereval);
                        if (whereval) {
                            let newimg = whereval.statusSelectColor;
                            newshapeProps.moduleJson.children[0].attrs.image = newimg;
                        }
                    }
                }
                if (newshapeProps.moduleJson.children[0].className === 'Echart' || newshapeProps.moduleJson.children[0].className === 'pueHtml') {// Comment translated to English.
                    newshapeProps.moduleJson.children[0].attrs.data = collectVal;
                }
                if (newshapeProps.moduleJson.children[0].className === 'leakWater') {// Comment translated to English.
                    newshapeProps.moduleJson.children[0].attrs.data = collectVal;
                    let srcalarm = [];
                    if (alarmdata && alarmdata.data) srcalarm = alarmdata.data.filter(v => sameId(v.DevId, element.key) && v.TextMessage && v.TextMessage.split(',')[2].replace(v.TypeName, '') === element.name); // Comment translated to English.
                    // Comment translated to English.
                    // console.log(srcalarm)
                    if (srcalarm.length !== 0) {
                        newshapeProps.moduleJson.children[0].attrs.haveAlarm = '1';
                    } else {
                        newshapeProps.moduleJson.children[0].attrs.haveAlarm = '0';
                    }
                }
                return newshapeProps;
            } else {
                return newshapeProps;
            }
        }
        // Comment translated to English.
        async function fetchparData(element, newshapeProps, dataWhere) {
            // let res = await httpsend.getData('GetParamDetailKey', {
            //     id: element.parkey,
            // })
            if (!paramdata) return newshapeProps;
            let res = {
                data: paramdata.data.find(v => v.id === element.parkey)
            }
            if (res.data) {
                let collectVal = res.data.Result;
                // Comment translated to English.
                if (newshapeProps.moduleJson.children[0].className === 'Text') {// Comment translated to English.
                    if (dataWhere) {// Comment translated to English.
                        let whereval = Number.isFinite(Number(collectVal)) ? dataWhere.find(v => Number(v.conditionNum) === Number(collectVal)) : dataWhere.find(v => v.conditionNum === collectVal);
                        newshapeProps.moduleJson.children[0].attrs.text = whereval.conditionText;
                        newshapeProps.moduleJson.children[0].attrs.fill = whereval.statusSelectColor;
                    } else {
                        newshapeProps.moduleJson.children[0].attrs.text = collectVal;
                    }
                }
                if (newshapeProps.moduleJson.children[0].className === 'Image') {// Comment translated to English.
                    if (dataWhere) {// Comment translated to English.
                        let whereval = Number.isFinite(Number(collectVal)) ? dataWhere.find(v => Number(v.conditionNum) === Number(collectVal)) : dataWhere.find(v => v.conditionNum === collectVal);
                        if (whereval) {
                            let newimg = whereval.statusSelectColor;
                            newshapeProps.moduleJson.children[0].attrs.image = newimg;
                        }
                    }
                }
                if (newshapeProps.moduleJson.children[0].className === 'Echart' || newshapeProps.moduleJson.children[0].className === 'pueHtml' || newshapeProps.moduleJson.children[0].className === 'gauge') {// Comment translated to English.
                    newshapeProps.moduleJson.children[0].attrs.data = collectVal;
                }
                return JSON.parse(JSON.stringify(newshapeProps));
            } else {
                return newshapeProps;
            }
        }
        // console.log(newProcotol)
        // console.log(newCommandData)
        // console.log(newHistoryData)

        let newimages = [];
        iamges.forEach(async (shapeProps) => {
            if (shapeProps.moduleJson) {
                let newshapeProps = JSON.parse(JSON.stringify(shapeProps));
                const dataKey = newshapeProps.moduleJson.attrs.dataKey;// Comment translated to English.
                if (dataKey && dataKey.length > 0) {
                    const dataWhere = newshapeProps.moduleJson.attrs.where;// Comment translated to English.
                    const dataArr = newshapeProps.moduleJson.attrs.moduleAttr.find(v => v.attrGroupName === t('auto.k0601'));
                    const dataType = dataArr.attrGroupContent[0].attrCode;// Comment translated to English.
                    switch (dataType) {
                        case 'dataKey':// Comment translated to English.
                            if (dataKey[0].parkey) {// Comment translated to English.
                                newshapeProps = await fetchparData(dataKey[0], newshapeProps, dataWhere);
                            } else {// Comment translated to English.
                                newshapeProps = await fetchData(dataKey[0], newshapeProps, dataWhere);
                            }
                            newimages.push(JSON.parse(JSON.stringify(newshapeProps)));
                            break;
                        case 'eventKey':// Comment translated to English.
                            let haveam = false;
                            dataKey.forEach(async (el) => {
                                let srcalarmevent = [];
                                if (alarmdata && alarmdata.data) {
                                    srcalarmevent = alarmdata.data.filter(v => el.eventskey ?
                                        (v.NotifyModeID === el.eventskey || (sameId(v.DevId, el.eventsdevkey) && v.TextMessage && v.TextMessage.split(',')[2].replace(v.TypeName, '') === el.name)) :
                                        (sameId(v.DevId, el.deveventskey))); // Comment translated to English.
                                    // Comment translated to English.
                                    // console.log(srcalarmevent);
                                }
                                if (srcalarmevent.length !== 0) {
                                    haveam = true;
                                    return false;
                                }
                            });
                            if (haveam) {
                                newshapeProps.moduleJson.children[0].attrs.fill = '#ff2626';// Comment translated to English.
                            }
                            newimages.push(newshapeProps);
                            break;
                        case 'pageKey':// Comment translated to English.
                            newshapeProps.clickEvnt = dataKey;
                            delete (newshapeProps.moduleJson.attrs.dataKey);
                            newimages.push(JSON.parse(JSON.stringify(newshapeProps)));
                            break;
                        case 'dataParamsKey':// Comment translated to English.
                            // Comment translated to English.
                            // Comment translated to English.
                            let type = dataKey[0].paramskey ? 'cusparam' : 'dev';
                            if (type === 'cusparam') {
                                if (!historyparamdata) return false;
                            } else {
                                if (!histroydata) return false;
                            }
                            if (newshapeProps.moduleJson.children[0].className === 'Echart' && newshapeProps.moduleJson.children[0].attrs.cat === 'line') {
                                let lineType = newshapeProps.moduleJson.children[0].attrs.dataType
                                let linedata = [];
                                let datatime = [];
                                let timeNum = 24;
                                let dayNum = 7;
                                switch (lineType) {
                                    case 'hour':
                                        dayNum = 0;
                                        break;
                                    case 'day':
                                        dayNum = 7;
                                        break;
                                    case 'month':
                                        dayNum = 30;
                                        break;
                                    default: break;
                                }
                                if (dayNum !== 0) {
                                    for (let index = 0; index < dayNum; index++) {
                                        datatime.push(getDateTime(new Date(new Date() - 1000 * 60 * 60 * 24 * (index + 1))))
                                    }
                                } else {
                                    for (let index = 0; index < timeNum; index++) {
                                        datatime.push(getDateTimeHour(new Date(new Date() - 1000 * 60 * 60 * (index + 1))) + t('auto.k0609'))
                                    }
                                }
                                // console.log(datatime);
                                datatime = datatime.reverse();
                                dataKey.forEach(async (el) => {
                                    let res = {
                                        data: []
                                    }
                                    if (type === 'cusparam') {
                                        res.data = historyparamdata.data.filter(v => v.ParamId === el.paramskey)
                                    } else {
                                        res.data = newHistoryData.filter(v => sameId(v.DevID, el.devkey))
                                    }
                                    // Comment translated to English.
                                    // console.log(el.devkey)
                                    // console.log(res.data)

                                    // console.log(el);
                                    let linethis = {
                                        "name": el.name,
                                        "data": [],
                                        "type": "line",
                                        "smooth": true
                                    }
                                    for (let index = 0; index < (dayNum === 0 ? timeNum : dayNum); index++) {
                                        if (dayNum === 0) {
                                            linethis.data.push(0)
                                        } else {
                                            linethis.data.push([])
                                        }
                                    }
                                    if (res.data) {
                                        if (type !== 'cusparam') {// Comment translated to English.
                                            datatime.forEach((y, x) => {
                                                if (dayNum !== 0) {
                                                    let findthis = res.data.filter(val => val.create_time.split(' ')[0] === y && val.collectData && val.collectData[el.name]);
                                                    // console.log(findthis)
                                                    if (findthis) {
                                                        // let findData = res.data[findthis]['collectData'][el.name];
                                                        // Comment translated to English.
                                                        // linethis.name = res.data[findthis].DeviceName + '=' + el.name;
                                                        // linethis.data[x].push(parseFloat(collectVal));
                                                        const sum = findthis.reduce((accumulator, vals) => accumulator + parseFloat(vals['collectData'][el.name].indexOf('(') > -1 ? vals['collectData'][el.name].split('(')[0] : vals['collectData'][el.name]), 0);
                                                        // console.log(sum)
                                                        linethis.name = el.dev + '=' + el.name;
                                                        linethis.data[x] = (sum / findthis.length).toFixed(2);
                                                    }
                                                } else {// Comment translated to English.
                                                    let findthis = res.data.findIndex(val => val.create_time.split(':')[0] === y.split(t('auto.k0609'))[0] && val.collectData && val.collectData[el.name]);
                                                    if (findthis > -1) {
                                                        let findData = res.data[findthis]['collectData'][el.name];
                                                        let collectVal = findData.indexOf('(') > -1 ? findData.split('(')[0] : findData;// Comment translated to English.
                                                        linethis.name = el.dev + '=' + el.name;
                                                        linethis.data[x] = parseFloat(collectVal);
                                                    }
                                                }
                                            })
                                        } else {// Comment translated to English.
                                            datatime.forEach((y, x) => {
                                                let findthis = 0;
                                                if (dayNum !== 0) {
                                                    findthis = res.data.findIndex(v => v.Day.split(' ')[0] === y);
                                                } else {// Comment translated to English.
                                                    findthis = res.data.findIndex(v => v.Day.split(':')[0] === y.split(t('auto.k0609'))[0]);
                                                }
                                                if (findthis > -1) {
                                                    linethis.data[x] = parseFloat(res.data[findthis].Result);
                                                } else {
                                                    linethis.data[x] = 0;
                                                }
                                            })
                                        }
                                    } else {
                                        datatime.forEach((y, x) => {
                                            linethis.data[x] = 0;
                                        })
                                    }
                                    // console.log(JSON.parse(JSON.stringify(linethis)))
                                    // if (type !== 'cusparam' && dayNum !== 0) {
                                    //     linethis.data.forEach((m, k) => {
                                    //         if (m.length !== 0) {
                                    //             const sum = m.reduce((accumulator, currentValue) => accumulator + currentValue, 0);
                                    //             linethis.data[k] = (sum / m.length).toFixed(2)
                                    //         } else {
                                    //             linethis.data[k] = 0;
                                    //         }
                                    //     })
                                    // }
                                    linedata.push(linethis);
                                });
                                newshapeProps.moduleJson.children[0].attrs.data = linedata;
                                newshapeProps.moduleJson.children[0].attrs.xdata = datatime;
                                newimages.push(newshapeProps);
                            }
                            // Comment translated to English.
                            if (newshapeProps.moduleJson.children[0].className === 'Echart' && newshapeProps.moduleJson.children[0].attrs.cat === 'bar') {
                                let barlinedata = [{
                                    "name": t('auto.k0601'),
                                    "data": [],
                                    "type": "bar"
                                }];
                                let barxdata = [];
                                dataKey.forEach(async (element) => {
                                    // let res = await httpsend.getData('GetDeviceCommandListKey', {
                                    //     DevID: element.devkey,
                                    //     ComboBox: '1'
                                    // })
                                    if (type === 'cusparam') {
                                        if (paramdata && paramdata.data) {
                                            let res = paramdata.data.find(v => v.id === element.paramskey);
                                            if (res) {
                                                barlinedata[0].data.push(parseFloat(res.Result));
                                                barxdata.push(element.name);
                                            } else {
                                                barlinedata[0].data.push(0);
                                                barxdata.push('');
                                            }
                                        }
                                    } else {
                                        let res = {
                                            data: []
                                        };
                                        res.data = newCommandData.filter(v => sameId(v.DevID, element.devkey));
                                        if (res.data) {
                                            let findthis = res.data.findIndex(val => val.collectData[element.name] && val.collectData);
                                            if (findthis > -1) {
                                                let findData = res.data[findthis]['collectData'][element.name];
                                                let collectVal = findData.indexOf('(') > -1 ? findData.split('(')[0] : findData;// Comment translated to English.
                                                barlinedata[0].data.push(parseFloat(collectVal));
                                                barxdata.push(res.data[findthis].DeviceName + '-' + element.name);
                                            } else {
                                                barlinedata[0].data.push(0);
                                                barxdata.push('');
                                            }
                                        } else {
                                            barlinedata[0].data.push(0);
                                            barxdata.push('');
                                        }
                                    }
                                })
                                newshapeProps.moduleJson.children[0].attrs.data = barlinedata;
                                newshapeProps.moduleJson.children[0].attrs.xdata = barxdata;
                                newimages.push(newshapeProps);
                            }
                            // Comment translated to English.
                            if (newshapeProps.moduleJson.children[0].className === 'Echart' && (
                                newshapeProps.moduleJson.children[0].attrs.cat === 'pie'
                                || newshapeProps.moduleJson.children[0].attrs.cat === 'huan'
                            )) {
                                let pielinedata = [];
                                dataKey.forEach(async (element) => {
                                    let piethis = { "value": 0, "name": element.name };
                                    // let res = await httpsend.getData('GetDeviceCommandListKey', {
                                    //     DevID: element.devkey,
                                    //     ComboBox: '1'
                                    // })
                                    if (type === 'cusparam') {
                                        let res;
                                        if (paramdata && paramdata.data) res = paramdata.data.find(v => v.id === element.paramskey);
                                        if (res) {
                                            piethis.value = res.Result;
                                            pielinedata.push(piethis);
                                        } else {
                                            pielinedata.push(piethis);
                                        }
                                    } else {
                                        let res = {
                                            data: []
                                        };
                                        res.data = newCommandData.filter(v => sameId(v.DevID, element.devkey));
                                        if (res.data) {
                                            let findthis = res.data.findIndex(val => val.collectData[element.name] && val.collectData);
                                            if (findthis > -1) {
                                                let findData = res.data[findthis]['collectData'][element.name];
                                                let collectVal = findData.indexOf('(') > -1 ? findData.split('(')[0] : findData;// Comment translated to English.
                                                piethis.value = parseFloat(collectVal);
                                                piethis.name = element.dev + '-' + element.name;
                                                pielinedata.push(piethis);
                                            } else {
                                                pielinedata.push(piethis);
                                            }
                                        } else {
                                            pielinedata.push(piethis);
                                        }
                                    }
                                })
                                // console.log(pielinedata);
                                newshapeProps.moduleJson.children[0].attrs.data = pielinedata;
                                newimages.push(newshapeProps);
                            }
                            break;
                        case 'dataDevKey':// Comment translated to English.
                            let element = dataKey[0];
                            // let res = await httpsend.getData('GetDeviceCommandListKey', {
                            //     DevID: element.key,
                            //     ComboBox: '1'
                            // })
                            let res = {
                                data: []
                            };
                            res.data = newCommandData.filter(v => sameId(v.DevID, element.key));
                            if (res.data) {
                                // Comment translated to English.
                                if (newshapeProps.moduleJson.children[0].className === 'wetHtml') {// Comment translated to English.
                                    let findthis = res.data.findIndex(val => val.collectData[t('auto.k0610')] && val.collectData[t('auto.k0611')] && val.collectData);
                                    let srcalarmwen = [];
                                    let srcalarmwet = [];
                                    if (alarmdata && alarmdata.data) {
                                        srcalarmwen = alarmdata.data.filter(v => sameId(v.DevId, element.key) && v.TextMessage && v.TextMessage.split(',')[2].replace(v.TypeName, '') === t('auto.k0610')); // Comment translated to English.
                                        srcalarmwet = alarmdata.data.filter(v => sameId(v.DevId, element.key) && v.TextMessage && v.TextMessage.split(',')[2].replace(v.TypeName, '') === t('auto.k0611')); // Comment translated to English.
                                    }
                                    if (findthis > -1) {
                                        let findData = res.data[findthis]['collectData'];
                                        let collectwenVal = findData[t('auto.k0610')].indexOf('(') > -1 ? findData[t('auto.k0610')].split('(')[0] : findData[t('auto.k0610')];
                                        let collectwetVal = findData[t('auto.k0611')].indexOf('(') > -1 ? findData[t('auto.k0611')].split('(')[0] : findData[t('auto.k0611')];
                                        newshapeProps.moduleJson.children[0].attrs.dataWen = parseFloat(collectwenVal);
                                        newshapeProps.moduleJson.children[0].attrs.dataWet = parseFloat(collectwetVal);
                                        if (srcalarmwen.length !== 0) newshapeProps.moduleJson.children[0].attrs.fill1 = '#ff2626';
                                        if (srcalarmwet.length !== 0) newshapeProps.moduleJson.children[0].attrs.fill2 = '#ff2626';
                                    } else {
                                        newshapeProps.moduleJson.children[0].attrs.dataWen = 0;
                                        newshapeProps.moduleJson.children[0].attrs.dataWet = 0;
                                        if (srcalarmwen.length !== 0) newshapeProps.moduleJson.children[0].attrs.fill1 = '#ff2626';
                                        if (srcalarmwet.length !== 0) newshapeProps.moduleJson.children[0].attrs.fill2 = '#ff2626';
                                    }
                                }
                                // Comment translated to English.
                                if (newshapeProps.moduleJson.children[0].className === 'paraHtml') {// Comment translated to English.
                                    // Comment translated to English.
                                    if (newshapeProps.moduleJson.children[0].attrs.datadata) {
                                        let finddata = res.data.find(v => v.CommandDesc === newshapeProps.moduleJson.children[0].attrs.datadata);
                                        let finddata2 = res.data.find(v => v.CommandDesc === newshapeProps.moduleJson.children[0].attrs.statedata);
                                        let finddata3 = res.data.find(v => v.CommandDesc === newshapeProps.moduleJson.children[0].attrs.alarmdata);
                                        if (finddata) {
                                            let resArr = finddata['collectData'];
                                            let data = [];
                                            if (resArr) {
                                                for (let key in resArr) {
                                                    let newvalue = resArr[key].indexOf('(') > -1 ? resArr[key].split('(')[0] : resArr[key];
                                                    let newunit = resArr[key].indexOf('(') > -1 ? resArr[key].split('(')[1].split(')')[0] : '';
                                                    data.push({
                                                        "name": key, "value": newvalue, "unit": newunit
                                                    })
                                                }
                                            }
                                            newshapeProps.moduleJson.children[0].attrs.data1 = data;
                                        } else {
                                            newshapeProps.moduleJson.children[0].attrs.data1 = [];
                                        }
                                        if (finddata2) {
                                            let resArr = finddata2['collectData'];
                                            let data = [];
                                            if (resArr) {
                                                for (let key in resArr) {
                                                    let newvalue = resArr[key].indexOf('(') > -1 ? resArr[key].split('(')[0] : resArr[key];
                                                    data.push({
                                                        "name": key, "value": newvalue
                                                    })
                                                }
                                            }
                                            newshapeProps.moduleJson.children[0].attrs.data2 = data;
                                        } else {
                                            newshapeProps.moduleJson.children[0].attrs.data2 = [];
                                        }
                                        if (finddata3) {
                                            // console.log(finddata3)
                                            let resArr = finddata3['collectData'];
                                            let data = [];
                                            // console.log(resArr)
                                            if (resArr) {
                                                for (let key in resArr) {
                                                    let newvalue = resArr[key].indexOf('(') > -1 ? resArr[key].split('(')[0] : resArr[key];
                                                    data.push({
                                                        "name": key, "value": newvalue
                                                    })
                                                }
                                            }
                                            // console.log(data)
                                            newshapeProps.moduleJson.children[0].attrs.data3 = data;
                                        } else {
                                            newshapeProps.moduleJson.children[0].attrs.data3 = [];
                                        }
                                    }
                                }
                            }
                            newimages.push(newshapeProps);
                            break;
                        default: break;
                    }
                } else {
                    if (newshapeProps.moduleJson.children[0].className === 'alarmList') {// Comment translated to English.
                        if (alarmdata && alarmdata.data) {
                            // Comment translated to English.
                            alarmdata.data.forEach(element => {
                                const rawLevel = (
                                    element.AlarmLevel !== undefined ? element.AlarmLevel
                                        : (element.alarmLevel !== undefined ? element.alarmLevel : element.level)
                                );
                                const levelMeta = resolveAlarmLevelMeta(rawLevel);
                                element.colorName = levelMeta.colorName;
                                if (levelMeta.levelName) element.LevelName = levelMeta.levelName;
                                element.AlarmName = element.TypeName;
                                element.AlarmTime = element.update_time;
                                if (element.TextMessage) {// Comment translated to English.
                                    let msgArr = element.TextMessage.split(',');
                                    element.AlarmName = msgArr[2];
                                    let dealAlarmTime = msgArr[4].replace(t('auto.k0607'), '-').replace(t('auto.k0608'), ' ');
                                    element.AlarmTime = element.create_time.split('-')[0] + '-' + dealAlarmTime;
                                }
                            });
                            newshapeProps.moduleJson.children[0].attrs.data = alarmdata.data;
                        } else {
                            newshapeProps.moduleJson.children[0].attrs.data = [];
                        }
                        // console.log(newshapeProps)
                        newimages.push(newshapeProps);
                    } else if (newshapeProps.moduleJson.children[0].attrs.name === 'ipImage') {// Comment translated to English.
                        let srcalarm = [];
                        let ipArr = newshapeProps.moduleJson.children[0].attrs.ipKey.split(',');
                        if (alarmdata && alarmdata.data) {// Comment translated to English.
                            srcalarm = alarmdata.data.filter(item => {
                                const ipWithPort = `${item.DeviceIP}:${item.DevicePort}`;
                                const ipOnly = item.DeviceIP;

                                return ipArr.some(pattern => {
                                    // Comment translated to English.
                                    if (pattern.includes(':')) {
                                        return pattern === ipWithPort;
                                    } else {
                                        // Comment translated to English.
                                        return pattern === ipOnly;
                                    }
                                });
                            })
                            console.log(t('auto.k0612'))
                            console.log(srcalarm)
                        }
                        if (srcalarm.length !== 0) {
                            newshapeProps.moduleJson.children[0].attrs.haveAlarm = '1';
                        } else {
                            newshapeProps.moduleJson.children[0].attrs.haveAlarm = '0';
                        }
                        newimages.push(newshapeProps);
                    } else {
                        newimages.push(newshapeProps);
                    }
                }
            }
        })
        // Comment translated to English.
        // console.log(newimages)
        return newimages;
    }
}
