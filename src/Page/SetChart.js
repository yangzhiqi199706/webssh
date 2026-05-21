import * as echarts from "echarts";
import { t } from '../i18n';
// Comment translated to English.
// import * as echarts from 'echarts/lib/echarts';
// import { LineChart, BarChart, PieChart } from 'echarts/charts';
// import { GridComponent, LegendComponent, TooltipComponent, TitleComponent } from 'echarts/components';
// import httpsend from '../Assets/httpsend';
// echarts.use([LineChart, BarChart, PieChart, GridComponent, LegendComponent, TooltipComponent, TitleComponent]);

const isFirefox = typeof navigator !== 'undefined' && /firefox/i.test(navigator.userAgent || '');

const initChart = (element) => {
    if (!element) return null;
    const existChart = echarts.getInstanceByDom(element);
    if (existChart) {
        try {
            const painterType = existChart.getZr() && existChart.getZr().painter && existChart.getZr().painter.getType
                ? existChart.getZr().painter.getType()
                : '';
            const wantType = isFirefox ? 'svg' : 'canvas';
            if (painterType === wantType || !painterType) {
                return existChart;
            }
        } catch (e) {
            // fall through to recreate
        }
        existChart.dispose();
    }
    return echarts.init(element, null, { renderer: isFirefox ? 'svg' : 'canvas' });
};

const normalizeOptionForStableRender = (option) => {
    if (!option || typeof option !== 'object') return option;
    option.animation = false;
    option.animationDuration = 0;
    option.animationDurationUpdate = 0;
    option.animationEasing = 'linear';
    option.animationEasingUpdate = 'linear';
    option.stateAnimation = { duration: 0 };
    return option;
};

const safeSetOption = (chart, option) => {
    if (!chart || !option) return;
    try {
        const stableOption = normalizeOptionForStableRender(option);
        chart.setOption(stableOption, {
            notMerge: true,
            lazyUpdate: true,
            silent: true
        });
    } catch (e) {
        console.error('echarts setOption failed', e);
    }
};

// Comment translated to English.
const getAlarmData = async (element, chartInfo, alarmDataList) => {
    var alarmpieChart = initChart(element);
    // let res = await httpsend.getData('GroupAlarmStatisticKey', {
    //     "startDateTime": "1970-01-01 00:00:00",
    //     "endDateTime": "2099-12-31 23:59:59",
    //     "type": "level",
    //     "ServerCode": '',
    // })
    let alarmdata = [
        {name: t('auto.k0138'), value: 0},
        {name: t('auto.k0139'), value: 0},
        {name: t('auto.k0140'), value: 0},
        {name: t('auto.k0141'), value: 0},
        {name: t('auto.k0142'), value: 0}
    ];
    if (alarmDataList && Array.isArray(alarmDataList.data)) {
        const levelCount = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
        alarmDataList.data.forEach((item) => {
            const rawLevel = (
                item && item.AlarmLevel !== undefined ? item.AlarmLevel
                    : (item && item.alarmLevel !== undefined ? item.alarmLevel : (item ? item.level : undefined))
            );
            const level = rawLevel === undefined || rawLevel === null ? '' : String(rawLevel).trim();
            if (Object.prototype.hasOwnProperty.call(levelCount, level)) {
                levelCount[level] += 1;
            }
        });
        alarmdata = [
            { name: t('auto.k0138'), value: levelCount['1'] },
            { name: t('auto.k0139'), value: levelCount['2'] },
            { name: t('auto.k0140'), value: levelCount['3'] },
            { name: t('auto.k0141'), value: levelCount['4'] },
            { name: t('auto.k0142'), value: levelCount['5'] }
        ];
    }
    // const seriesAlarmData = alarmdata.filter((item) => Number(item.value) !== 0);
    const seriesAlarmData = alarmdata;
    let data = [
        {
            type: 'pie',
            radius: '70%',
            data: seriesAlarmData,
            label: {
                position: 'inside',
                color: chartInfo.dataColor
            },
        }
    ];
    if (chartInfo.roseSwitch === '2') {
        if (data) {
            data.forEach(ele => {
                ele['radius'] = [20, 100];
                ele['roseType'] = 'radius';
                ele['itemStyle'] = {
                    borderRadius: 5
                };
            })
        }
    }
    var alarmpieoption = {
        tooltip: {
            trigger: 'item'
        },
        title: {// Comment translated to English.
            show: chartInfo.titleSwitch === '2' ? true : false,
            text: chartInfo.titleSwitch === '2' ? chartInfo.title : '',
            textStyle: {
                color: chartInfo.titleColor,
                fontSize: chartInfo.titleFontSize
            }
        },
        legend: {// Comment translated to English.
            show: chartInfo.iconSwitch === '2' ? true : false,
            right: 10,
            textStyle: {
                color: chartInfo.iconColor
            },
            orient: chartInfo.orient,
            algin: chartInfo.algin
        },
        series: data
    };
    safeSetOption(alarmpieChart, alarmpieoption);
}
// Comment translated to English.
function echart(images, selectedId,alarmData) {
    setTimeout(() => {
        if (!document.querySelectorAll(".chart")) return;
        let chartlist = document.querySelectorAll(".chart");
        for (var i = 0; i < chartlist.length; i++) {
            var element = chartlist[i];
            let findimg = getImgIndex(images, element);
            if (findimg > -1 && images[findimg] && images[findimg].id) {
                // Comment translated to English.
                let chartInfo = images[findimg].moduleJson.children[0].attrs;
                if (chartInfo.cat === 'gauge') {// Comment translated to English.
                    var gaugeChart = initChart(element);
                    var gaugeoption = {
                        grid: {
                            left: 0,
                            top: 0,
                            bottom: 0,
                            right: 0
                        },
                        series: [
                            {
                                type: 'gauge',
                                max: chartInfo.max,
                                min: chartInfo.min,
                                progress: {// Comment translated to English.
                                    show: chartInfo.progressSwitch === '2' ? true : false
                                },
                                pointer: { // Comment translated to English.
                                    itemStyle: {
                                        color: chartInfo.progressSwitch === '2' ? chartInfo.progressColor : 'auto',
                                    }
                                },
                                axisTick: {// Comment translated to English.
                                    distance: 0,
                                    length: 3,
                                    lineStyle: {
                                        color: chartInfo.markColor,
                                        width: 1
                                    }
                                },
                                axisLabel: {// Comment translated to English.
                                    color: chartInfo.markFontColor,
                                },
                                itemStyle: {// Comment translated to English.
                                    color: chartInfo.progressSwitch === '2' ? chartInfo.progressColor : 'auto',
                                },
                                axisLine: {// Comment translated to English.
                                    lineStyle: {
                                        color: [
                                            [chartInfo.axisLine1, chartInfo.axisLineColor1],
                                            [chartInfo.axisLine2, chartInfo.axisLineColor2],
                                            [chartInfo.axisLine3, chartInfo.axisLineColor3],
                                            [chartInfo.axisLine4, chartInfo.axisLineColor4],
                                        ]
                                    }
                                },
                                splitLine: {// Comment translated to English.
                                    distance: 0,
                                    length: 5,
                                    lineStyle: {
                                        color: chartInfo.markColor,
                                        width: 1
                                    }
                                },
                                title: {
                                    offsetCenter: [0, '100%'],
                                    fontSize: chartInfo.titleFontSize,
                                    color: chartInfo.titleColor,
                                },
                                detail: {
                                    valueAnimation: true,
                                    formatter: '{value}',
                                    color: chartInfo.dataColor,
                                    fontSize: chartInfo.dataFontSize,
                                    offsetCenter: [0, '70%']
                                },
                                data: [
                                    {
                                        value: chartInfo.data,
                                        name: chartInfo.titleSwitch === '2' ? chartInfo.title : ""
                                    }
                                ]
                            }
                        ]
                    };
                    safeSetOption(gaugeChart, gaugeoption);
                } else if (chartInfo.cat === 'line') {// Comment translated to English.
                    var lineChart = initChart(element);
                    let top = 20;
                    let data = chartInfo.data;
                    let legenddata = [];
                    if (data) {
                        data.forEach(element => {
                            legenddata.push(element.name)
                        });
                    }
                    if (chartInfo.titleSwitch === '2') top = 50;
                    if (chartInfo.iconSwitch === '2') top = 50;
                    // Comment translated to English.
                    if (chartInfo.dataSwitch === '2') {
                        if (data) {
                            data.forEach(element => {
                                element['label'] = {
                                    show: true,
                                    position: 'top',
                                    color: chartInfo.dataColor,
                                    fontSize: chartInfo.dataFontSize
                                }
                            });
                        }
                    }
                    // Comment translated to English.
                    if (chartInfo.areaSwitch === '2') {
                        if (data) {
                            data.forEach(element => {
                                element['areaStyle'] = {}
                            });
                        }
                    }
                    var lineoption = {
                        grid: {
                            top: top,
                            left: 10,
                            right: 20,
                            bottom: 10,
                            containLabel: true,
                        },
                        tooltip: {
                            trigger: 'axis'
                        },
                        title: {// Comment translated to English.
                            show: chartInfo.titleSwitch === '2' ? true : false,
                            text: chartInfo.titleSwitch === '2' ? chartInfo.title : '',
                            textStyle: {
                                color: chartInfo.titleColor,
                                fontSize: chartInfo.titleFontSize
                            }
                        },
                        legend: {// Comment translated to English.
                            show: chartInfo.iconSwitch === '2' ? true : false,
                            data: legenddata,
                            right: 10,
                            textStyle: {
                                color: chartInfo.iconColor
                            }
                        },
                        xAxis: {
                            axisLine: {// Comment translated to English.
                                lineStyle: {
                                    color: chartInfo.xaxisLine
                                }
                            },
                            axisTick: {// Comment translated to English.
                                lineStyle: {
                                    color: chartInfo.markColor
                                }
                            },
                            axisLabel: {// Comment translated to English.
                                show: chartInfo.xTextShow === '2' ? true : false,
                                textStyle: {
                                    color: chartInfo.xColor,
                                }
                            },
                            show: chartInfo.xshow === '2' ? true : false,
                            type: 'category',
                            boundaryGap: true,// Comment translated to English.
                            data: chartInfo.xdata
                        },
                        yAxis: {
                            axisLine: {// Comment translated to English.
                                show: chartInfo.yshow === '2' ? true : false,
                                lineStyle: {
                                    color: chartInfo.yaxisLine
                                }
                            },
                            axisTick: {// Comment translated to English.
                                lineStyle: {
                                    color: chartInfo.markColor
                                }
                            },
                            axisLabel: {// Comment translated to English.
                                textStyle: {
                                    color: chartInfo.yColor,
                                }
                            },
                            splitLine: {
                                show: chartInfo.splitSwitch === '2' ? true : false,
                                lineStyle: {
                                    color: chartInfo.splitColor
                                }
                            },
                            type: 'value'
                        },
                        series: data
                    };

                    safeSetOption(lineChart, lineoption);
                } else if (chartInfo.cat === 'bar') {// Comment translated to English.
                    var barChart = initChart(element);
                    let top = 20;
                    let sourceData = Array.isArray(chartInfo.data) ? chartInfo.data : [];
                    let data = sourceData.map((series) => ({
                        ...series,
                        data: Array.isArray(series.data) ? [...series.data] : []
                    }));
                    let xdata = Array.isArray(chartInfo.xdata) ? [...chartInfo.xdata] : [];
                    const shouldSortBar = chartInfo.sortEnable === '2' && data.length > 0 && xdata.length > 0;
                    if (shouldSortBar) {
                        const sortSeriesIndex = chartInfo.sortTarget === 'first' ? 0 : parseInt(chartInfo.sortTarget, 10) || 0;
                        const safeSortSeriesIndex = sortSeriesIndex >= 0 && sortSeriesIndex < data.length ? sortSeriesIndex : 0;
                        const baseSeries = data[safeSortSeriesIndex];
                        const rows = xdata.map((name, index) => ({
                            name,
                            index,
                            sortValue: Number(baseSeries && Array.isArray(baseSeries.data) ? baseSeries.data[index] : 0) || 0
                        }));
                        rows.sort((a, b) => {
                            if (b.sortValue === a.sortValue) {
                                return a.index - b.index;
                            }
                            return chartInfo.sortOrder === 'asc' ? a.sortValue - b.sortValue : b.sortValue - a.sortValue;
                        });
                        // 显示前 N 个柱体：sortTopN > 0 时截取，否则保留全部
                        const topNRaw = parseInt(chartInfo.sortTopN, 10);
                        const topN = Number.isFinite(topNRaw) && topNRaw > 0 ? topNRaw : 0;
                        const limitedRows = topN > 0 ? rows.slice(0, topN) : rows;
                        xdata = limitedRows.map((row) => row.name);
                        data = data.map((series) => ({
                            ...series,
                            data: limitedRows.map((row) => {
                                const currentValue = Array.isArray(series.data) ? series.data[row.index] : 0;
                                return currentValue === undefined ? 0 : currentValue;
                            })
                        }));
                    }
                    let legenddata = [];
                    if (data) {
                        data.forEach(element => {
                            legenddata.push(element.name)
                        });
                    }
                    if (chartInfo.titleSwitch === '2') top = 50;
                    if (chartInfo.iconSwitch === '2') top = 50;
                    // Comment translated to English.
                    if (chartInfo.dataSwitch === '2') {
                        if (data) {
                            data.forEach(ele => {
                                ele['label'] = {
                                    show: true,
                                    position: 'top',
                                    color: chartInfo.dataColor,
                                    fontSize: chartInfo.dataFontSize
                                }
                            })
                        }
                    }
                    // Comment translated to English.
                    if (chartInfo.barbackgroundSwitch === '2') {
                        if (data) {
                            data.forEach(ele => {
                                ele['showBackground'] = true;
                                ele['backgroundStyle'] = {
                                    color: chartInfo.barbackground
                                }
                            })
                        }
                    }

                    var baroption = {
                        grid: {
                            top: top,
                            left: 10,
                            right: 20,
                            bottom: 10,
                            containLabel: true,
                        },
                        tooltip: {
                            trigger: 'axis'
                        },
                        title: {// Comment translated to English.
                            show: chartInfo.titleSwitch === '2' ? true : false,
                            text: chartInfo.titleSwitch === '2' ? chartInfo.title : '',
                            textStyle: {
                                color: chartInfo.titleColor,
                                fontSize: chartInfo.titleFontSize
                            }
                        },
                        legend: {// Comment translated to English.
                            show: chartInfo.iconSwitch === '2' ? true : false,
                            data: legenddata,
                            right: 10,
                            textStyle: {
                                color: chartInfo.iconColor
                            }
                        },
                        xAxis: {
                            axisLine: {// Comment translated to English.
                                show: chartInfo.xshow === '2' ? true : false,
                                lineStyle: {
                                    color: chartInfo.xaxisLine
                                }
                            },
                            axisTick: {// Comment translated to English.
                                lineStyle: {
                                    color: chartInfo.markColor
                                }
                            },
                            axisLabel: {// Comment translated to English.
                                show:chartInfo.xTextShow === '2' ? true : false,
                                textStyle: {
                                    color: chartInfo.xColor,
                                }
                            },
                            type: 'category',
                            data: xdata
                        },
                        yAxis: {
                            axisLine: {// Comment translated to English.
                                show: chartInfo.yshow === '2' ? true : false,
                                lineStyle: {
                                    color: chartInfo.yaxisLine
                                }
                            },
                            axisTick: {// Comment translated to English.
                                lineStyle: {
                                    color: chartInfo.markColor
                                }
                            },
                            axisLabel: {// Comment translated to English.
                                textStyle: {
                                    color: chartInfo.yColor,
                                }
                            },
                            splitLine: {
                                show: chartInfo.splitSwitch === '2' ? true : false,
                                lineStyle: {
                                    color: chartInfo.splitColor
                                }
                            },
                            type: 'value'
                        },
                        series: data
                    };

                    safeSetOption(barChart, baroption);
                } else if (chartInfo.cat === 'pie') {// Comment translated to English.
                    var pieChart = initChart(element);
                    let data = [
                        {
                            type: 'pie',
                            radius: '70%',
                            data: chartInfo.data,
                            label: {
                                position: 'inside',
                                color: chartInfo.dataColor
                            },
                        }
                    ];
                    if (chartInfo.roseSwitch === '2') {
                        if (data) {
                            data.forEach(ele => {
                                ele['radius'] = [20, 100];
                                ele['roseType'] = 'radius';
                                ele['itemStyle'] = {
                                    borderRadius: 5
                                };
                            })
                        }
                    }
                    var pieoption = {
                        tooltip: {
                            trigger: 'item'
                        },
                        title: {// Comment translated to English.
                            show: chartInfo.titleSwitch === '2' ? true : false,
                            text: chartInfo.titleSwitch === '2' ? chartInfo.title : '',
                            textStyle: {
                                color: chartInfo.titleColor,
                                fontSize: chartInfo.titleFontSize
                            }
                        },
                        legend: {// Comment translated to English.
                            show: chartInfo.iconSwitch === '2' ? true : false,
                            right: 10,
                            textStyle: {
                                color: chartInfo.iconColor
                            },
                            orient: chartInfo.orient,
                            algin: chartInfo.algin
                        },
                        series: data
                    };

                    safeSetOption(pieChart, pieoption);
                } else if (chartInfo.cat === 'alarmpie') {// Comment translated to English.
                    getAlarmData(element, chartInfo, alarmData);
                } else if (chartInfo.cat === 'huan') {// Comment translated to English.
                    var huanChart = initChart(element);
                    var huanoption = {
                        tooltip: {
                            trigger: 'item'
                        },
                        title: {// Comment translated to English.
                            show: chartInfo.titleSwitch === '2' ? true : false,
                            text: chartInfo.titleSwitch === '2' ? chartInfo.title : '',
                            textStyle: {
                                color: chartInfo.titleColor,
                                fontSize: chartInfo.titleFontSize
                            }
                        },
                        legend: {// Comment translated to English.
                            show: chartInfo.iconSwitch === '2' ? true : false,
                            right: 10,
                            textStyle: {
                                color: chartInfo.iconColor
                            },
                            orient: chartInfo.orient,
                            algin: chartInfo.algin
                        },
                        series: [
                            {
                                type: 'pie',
                                radius: ['40%', '70%'],
                                avoidLabelOverlap: false,
                                label: {
                                    show: false,
                                    position: 'center'
                                },
                                emphasis: {
                                    label: {
                                        show: chartInfo.dataSwitch === '2' ? true : false,
                                        fontSize: chartInfo.datafontSize,
                                        fontWeight: 'bold',
                                        color: chartInfo.dataColor
                                    }
                                },
                                labelLine: {
                                    show: false
                                },
                                data: chartInfo.data
                            }
                        ]
                    };

                    safeSetOption(huanChart, huanoption);
                } else if (chartInfo.cat === 'pue') {// Comment translated to English.
                    var pueChart = initChart(element);
                    var pueoption = {
                        grid: {
                            left: 0,
                            top: 0,
                            bottom: 0,
                            right: 0
                        },
                        series: [
                            {
                                type: 'gauge',
                                max: 10,
                                axisLine: {
                                    lineStyle: {
                                        width: 10,
                                        color: [
                                            [
                                                0.5,
                                                {
                                                    type: 'linear',
                                                    x: 0,
                                                    y: 0,
                                                    x2: 0,
                                                    y2: 1,
                                                    colorStops: [
                                                        {
                                                            offset: 0,
                                                            color: '#B19589'
                                                        },
                                                        {
                                                            offset: 1,
                                                            color: '#3550F7'
                                                        }
                                                    ],
                                                    global: false
                                                }
                                            ],
                                            [
                                                1,
                                                {
                                                    type: 'linear',
                                                    x: 0,
                                                    y: 0,
                                                    x2: 0,
                                                    y2: 1,
                                                    colorStops: [
                                                        {
                                                            offset: 0,
                                                            color: '#B19589'
                                                        },
                                                        {
                                                            offset: 1,
                                                            color: '#F9BE4A'
                                                        }
                                                    ],
                                                    global: false
                                                }
                                            ]
                                        ]
                                    }
                                },
                                pointer: {
                                    itemStyle: {
                                        color: 'auto'
                                    }
                                },
                                axisTick: {
                                    distance: -16,
                                    length: 5,
                                    lineStyle: {
                                        color: '#fff',
                                        width: 1
                                    }
                                },
                                splitLine: {
                                    distance: -28,
                                    length: 30,
                                    lineStyle: {
                                        color: '#fff',
                                        width: 0
                                    }
                                },
                                axisLabel: {
                                    color: '#fff',
                                    distance: 12,
                                    fontSize: 10
                                },
                                detail: {
                                    valueAnimation: true,
                                    formatter: '{value}',
                                    color: '#F8C472',
                                    fontSize: 20,
                                    offsetCenter: [0, '70%']
                                },
                                data: [
                                    {
                                        value: chartInfo.data
                                    }
                                ]
                            }
                        ]
                    };
                    safeSetOption(pueChart, pueoption);
                }
            }
        }
    }, 1000)
}
// Comment translated to English.
function getImgIndex(images, element) {
    if (images && element) {
        return images.findIndex(v => 'Echart' + v.id === element.getAttribute('id'));
    } else {
        return null
    }

}
export default echart;
