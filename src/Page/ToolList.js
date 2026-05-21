import React from "react";
import tools from './Data/tools.json';
import { localizeDeep } from '../i18n';

function ToolList(props) {
    let Toolarr=[];
    const localizedTools = localizeDeep(tools);
    localizedTools.map((val, index) => {
        let pathArr = [val.path];
        let colorArr = [val.color];
        if (val.path.indexOf('|') > 0) {
            pathArr = val.path.split('|');
            colorArr = val.color.split('|');
        }
        if (val.method === 'undo') {
            return Toolarr.push (
                <svg viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg"
                    title={val.name}
                    style={{ 'cursor': 'pointer' }}
                    key={index}
                    type={val.method}
                    onClick={(e) => {
                        props.handleTool(val.method)
                    }}>
                    {pathArr.map((k, n) => {
                        let colorL = colorArr[n];
                        return <path d={k} fill={colorL} key={n}></path>
                    })}
                    <title>{val.name}{'（' + val.alt + '）'}</title>
                </svg>
            );
        }
        return Toolarr.push (
            <svg viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg"
                title={val.name}
                style={(props.MultiSelect === val.MultiSelect) ? { 'cursor': 'pointer' } : { 'cursor': 'not-allowed' }}
                key={index}
                type={val.method}
                onClick={(e) => {
                    if (props.MultiSelect === val.MultiSelect) props.handleTool(val.method)
                }}>
                {pathArr.map((k, n) => {
                    let colorL = '#cccccc';
                    if (props.MultiSelect === val.MultiSelect) colorL = colorArr[n];
                    return <path d={k} fill={colorL} key={n}></path>
                })}
                <title>{val.name}{(props.MultiSelect === val.MultiSelect && !val.MultiSelect) && '（' + val.alt + '）'}</title>
            </svg>
        );
    })
    return Toolarr;
}
export default ToolList;
