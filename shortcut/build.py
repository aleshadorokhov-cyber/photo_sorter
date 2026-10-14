"""Собирает команду «По полочкам» для приложения «Команды» (Shortcuts) в виде plist.

Команда берёт из буфера обмена раскладку с сайта {"Альбом": ["IMG_1234", ...], ...},
находит каждый снимок в «Фото» по имени и создаёт альбомы. Запускается кнопкой на сайте.
Использование: python3 shortcut/build.py <файл.plist>
"""
import plistlib
import sys
import uuid

OBJ = '￼'


def uid():
    return str(uuid.uuid4()).upper()


def output(action_uuid, name):
    return {'Value': {'OutputName': name, 'OutputUUID': action_uuid, 'Type': 'ActionOutput'},
            'WFSerializationType': 'WFTextTokenAttachment'}


def variable(name):
    return {'Value': {'Type': 'Variable', 'VariableName': name},
            'WFSerializationType': 'WFTextTokenAttachment'}


def text_with(name):
    return {'Value': {'string': OBJ, 'attachmentsByRange': {'{0, 1}': {'Type': 'Variable', 'VariableName': name}}},
            'WFSerializationType': 'WFTextTokenString'}


def action(identifier, **params):
    return {'WFWorkflowActionIdentifier': f'is.workflow.actions.{identifier}', 'WFWorkflowActionParameters': params}


def build():
    clipboard, dictionary, keys, values = uid(), uid(), uid(), uid()
    outer, inner, found, inner_end = uid(), uid(), uid(), uid()
    actions = [
        action('getclipboard', UUID=clipboard),
        action('detect.dictionary', UUID=dictionary, WFInput=output(clipboard, 'Clipboard')),
        # Названия альбомов: ключи словаря
        action('getvalueforkey', UUID=keys, WFGetDictionaryValueType='All Keys',
               WFInput=output(dictionary, 'Dictionary')),
        action('repeat.each', GroupingIdentifier=outer, WFControlFlowMode=0,
               WFInput=output(keys, 'Dictionary Value')),
        # Имена снимков этого альбома
        action('getvalueforkey', UUID=values, WFGetDictionaryValueType='Value',
               WFDictionaryKey=text_with('Repeat Item'), WFInput=output(dictionary, 'Dictionary')),
        action('repeat.each', GroupingIdentifier=inner, WFControlFlowMode=0,
               WFInput=output(values, 'Dictionary Value')),
        action('filter.photos', UUID=found, WFContentItemLimitEnabled=True, WFContentItemLimitNumber=1.0,
               WFContentItemFilter={
                   'Value': {
                       'WFActionParameterFilterPrefix': 1,
                       'WFContentPredicateBoundedDate': False,
                       'WFActionParameterFilterTemplates': [{
                           'Operator': 8,  # «begins with»: имя в «Фото» может быть с расширением
                           'Property': 'Name',
                           'Removable': True,
                           'Values': {'Unit': 4, 'String': text_with('Repeat Item 2')},
                       }],
                   },
                   'WFSerializationType': 'WFContentPredicateTableTemplate',
               }),
        action('repeat.each', GroupingIdentifier=inner, WFControlFlowMode=2, UUID=inner_end),
        action('photos.createalbum', AlbumName=text_with('Repeat Item'),
               WFInput=output(inner_end, 'Repeat Results')),
        action('repeat.each', GroupingIdentifier=outer, WFControlFlowMode=2, UUID=uid()),
    ]
    return {
        'WFWorkflowClientVersion': '2302.0.4',
        'WFWorkflowMinimumClientVersion': 900,
        'WFWorkflowMinimumClientVersionString': '900',
        'WFWorkflowIcon': {'WFWorkflowIconStartColor': 4282601983, 'WFWorkflowIconGlyphNumber': 59511},
        'WFWorkflowActions': actions,
        'WFWorkflowInputContentItemClasses': [],
        'WFWorkflowOutputContentItemClasses': [],
        'WFWorkflowImportQuestions': [],
        'WFWorkflowTypes': [],
        'WFQuickActionSurfaces': [],
        'WFWorkflowHasOutputFallback': False,
        'WFWorkflowHasShortcutInputVariables': False,
    }


if __name__ == '__main__':
    with open(sys.argv[1], 'wb') as f:
        plistlib.dump(build(), f, fmt=plistlib.FMT_XML)
